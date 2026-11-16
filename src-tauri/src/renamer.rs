use crate::parser::{parse_filename, validate_windows_filename, ParsedFilename, RecognitionStatus};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileScanItem {
    pub id: String,
    pub folder_path: String,
    pub original_name: String,
    pub full_path: String,
    pub size_bytes: u64,
    pub is_video: bool,
    pub parsed: ParsedFilename,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameRequestItem {
    pub original_name: String,
    pub target_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameOperationRecord {
    pub original_name: String,
    pub new_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameBatchRecord {
    pub batch_id: String,
    pub folder_path: String,
    pub timestamp: String,
    pub operations: Vec<RenameOperationRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    pub original_name: String,
    pub target_name: String,
    pub status: RecognitionStatus,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRenameResult {
    pub success: bool,
    pub renamed_count: usize,
    pub batch: Option<RenameBatchRecord>,
    pub errors: Vec<String>,
}

const VIDEO_EXTENSIONS: &[&str] = &[
    ".mkv", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v", ".mpg", ".mpeg", ".ts",
    ".m2ts", ".ogv", ".3gp", ".srt", ".ass", ".sub", ".vtt",
];

pub fn is_supported_media_file(filename: &str) -> bool {
    let lower = filename.to_lowercase();
    VIDEO_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
}

pub fn scan_directory(folder_path: &Path, include_all_files: bool) -> Result<Vec<FileScanItem>, String> {
    if !folder_path.exists() {
        return Err(format!("Folder does not exist: {}", folder_path.display()));
    }
    if !folder_path.is_dir() {
        return Err(format!("Path is not a directory: {}", folder_path.display()));
    }

    let entries = fs::read_dir(folder_path)
        .map_err(|e| format!("Failed to read directory '{}': {}", folder_path.display(), e))?;

    let mut existing_filenames_lower = HashSet::new();
    let mut raw_files = Vec::new();

    for entry_res in entries {
        let entry = entry_res.map_err(|e| format!("Error reading entry: {}", e))?;
        let path = entry.path();
        if path.is_file() {
            if let Some(name_os) = path.file_name() {
                let name = name_os.to_string_lossy().to_string();
                existing_filenames_lower.insert(name.to_lowercase());
                let metadata = entry.metadata().ok();
                let size_bytes = metadata.map(|m| m.len()).unwrap_or(0);
                let is_video = is_supported_media_file(&name);
                if include_all_files || is_video {
                    raw_files.push((name, path, size_bytes, is_video));
                }
            }
        }
    }

    raw_files.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));

    let mut items: Vec<FileScanItem> = raw_files
        .into_iter()
        .map(|(name, path, size_bytes, is_video)| {
            let parsed = parse_filename(&name);
            FileScanItem {
                id: Uuid::new_v4().to_string(),
                folder_path: folder_path.to_string_lossy().to_string(),
                original_name: name,
                full_path: path.to_string_lossy().to_string(),
                size_bytes,
                is_video,
                parsed,
            }
        })
        .collect();

    recompute_batch_conflicts(&mut items, &existing_filenames_lower);

    Ok(items)
}

pub fn recompute_batch_conflicts(
    items: &mut [FileScanItem],
    existing_disk_files_lower: &HashSet<String>,
) {
    let mut target_counts: HashMap<String, usize> = HashMap::new();
    let mut batch_originals_lower: HashSet<String> = HashSet::new();

    for item in items.iter() {
        batch_originals_lower.insert(item.original_name.to_lowercase());
        if matches!(
            item.parsed.status,
            RecognitionStatus::Ready | RecognitionStatus::DuplicateTarget | RecognitionStatus::DiskConflict
        ) {
            let key = item.parsed.suggested_name.to_lowercase();
            *target_counts.entry(key).or_insert(0) += 1;
        }
    }

    for item in items.iter_mut() {
        if let Err(err) = validate_windows_filename(&item.parsed.suggested_name) {
            item.parsed.status = RecognitionStatus::InvalidChars;
            item.parsed.reason = Some(err);
            continue;
        }

        if matches!(
            item.parsed.status,
            RecognitionStatus::Ambiguous | RecognitionStatus::Unrecognized | RecognitionStatus::Unchanged
        ) {
            continue;
        }

        let target_lower = item.parsed.suggested_name.to_lowercase();
        let orig_lower = item.original_name.to_lowercase();

        if target_counts.get(&target_lower).copied().unwrap_or(0) > 1 {
            item.parsed.status = RecognitionStatus::DuplicateTarget;
            item.parsed.reason = Some(format!(
                "Multiple files in this batch would be renamed to '{}'",
                item.parsed.suggested_name
            ));
        } else if target_lower != orig_lower
            && existing_disk_files_lower.contains(&target_lower)
            && !batch_originals_lower.contains(&target_lower)
        {
            item.parsed.status = RecognitionStatus::DiskConflict;
            item.parsed.reason = Some(format!(
                "A file named '{}' already exists in the folder",
                item.parsed.suggested_name
            ));
        } else if item.parsed.suggested_name == item.original_name {
            item.parsed.status = RecognitionStatus::Unchanged;
            item.parsed.reason = None;
        } else {
            item.parsed.status = RecognitionStatus::Ready;
            item.parsed.reason = None;
        }
    }
}

pub fn validate_rename_plan(
    folder_path: &Path,
    requests: &[RenameRequestItem],
) -> Result<Vec<ValidationIssue>, String> {
    if !folder_path.exists() || !folder_path.is_dir() {
        return Err(format!("Invalid directory: {}", folder_path.display()));
    }

    let mut issues = Vec::new();
    let mut target_counts: HashMap<String, usize> = HashMap::new();
    let mut source_set_lower: HashSet<String> = HashSet::new();

    for req in requests {
        if req.original_name != req.target_name {
            *target_counts.entry(req.target_name.to_lowercase()).or_insert(0) += 1;
            source_set_lower.insert(req.original_name.to_lowercase());
        }
    }

    let existing_entries = fs::read_dir(folder_path)
        .map_err(|e| format!("Failed to inspect directory: {}", e))?;
    let mut disk_files_lower: HashSet<String> = HashSet::new();
    for entry in existing_entries.flatten() {
        if entry.path().is_file() {
            if let Some(name) = entry.path().file_name() {
                disk_files_lower.insert(name.to_string_lossy().to_lowercase());
            }
        }
    }

    for req in requests {
        if req.original_name == req.target_name {
            continue;
        }

        if let Err(msg) = validate_windows_filename(&req.target_name) {
            issues.push(ValidationIssue {
                original_name: req.original_name.clone(),
                target_name: req.target_name.clone(),
                status: RecognitionStatus::InvalidChars,
                message: msg,
            });
            continue;
        }

        let src_path = folder_path.join(&req.original_name);
        if !src_path.exists() {
            issues.push(ValidationIssue {
                original_name: req.original_name.clone(),
                target_name: req.target_name.clone(),
                status: RecognitionStatus::DiskConflict,
                message: format!("Source file '{}' no longer exists on disk", req.original_name),
            });
            continue;
        }

        let target_lower = req.target_name.to_lowercase();
        let orig_lower = req.original_name.to_lowercase();

        if target_counts.get(&target_lower).copied().unwrap_or(0) > 1 {
            issues.push(ValidationIssue {
                original_name: req.original_name.clone(),
                target_name: req.target_name.clone(),
                status: RecognitionStatus::DuplicateTarget,
                message: format!("Duplicate destination filename '{}'", req.target_name),
            });
            continue;
        }

        if target_lower != orig_lower
            && disk_files_lower.contains(&target_lower)
            && !source_set_lower.contains(&target_lower)
        {
            issues.push(ValidationIssue {
                original_name: req.original_name.clone(),
                target_name: req.target_name.clone(),
                status: RecognitionStatus::DiskConflict,
                message: format!(
                    "Target file '{}' already exists on disk and would be overwritten",
                    req.target_name
                ),
            });
        }
    }

    Ok(issues)
}

/// Safe two-phase atomic-style batch rename:
/// Phase 1: Rename every participating source file to a unique temporary `.sbfr_tmp_<uuid>` name in the same folder.
///          This guarantees that:
///          (a) Case-only renames on Windows NTFS (e.g., `trigger s01e01.mkv` -> `Trigger S01E01.mkv`) succeed cleanly.
///          (b) Cyclic/chained renames within a batch never clobber one another.
///          (c) We never overwrite any untouched file on disk.
/// Phase 2: Rename each temporary file to its final destination name, verifying before each move that the destination path does not exist.
///          If any error occurs during Phase 1 or Phase 2, all completed steps are rolled back automatically.
pub fn execute_batch_rename(
    folder_path: &Path,
    requests: &[RenameRequestItem],
) -> BatchRenameResult {
    let active_requests: Vec<RenameRequestItem> = requests
        .iter()
        .filter(|r| r.original_name != r.target_name)
        .cloned()
        .collect();

    if active_requests.is_empty() {
        return BatchRenameResult {
            success: true,
            renamed_count: 0,
            batch: None,
            errors: Vec::new(),
        };
    }

    match validate_rename_plan(folder_path, &active_requests) {
        Ok(issues) if !issues.is_empty() => {
            return BatchRenameResult {
                success: false,
                renamed_count: 0,
                batch: None,
                errors: issues
                    .into_iter()
                    .map(|i| format!("{} -> {}: {}", i.original_name, i.target_name, i.message))
                    .collect(),
            };
        }
        Err(e) => {
            return BatchRenameResult {
                success: false,
                renamed_count: 0,
                batch: None,
                errors: vec![e],
            };
        }
        Ok(_) => {}
    }

    struct StagedItem {
        original_name: String,
        temp_name: String,
        target_name: String,
        orig_path: PathBuf,
        temp_path: PathBuf,
        target_path: PathBuf,
    }

    let mut staged: Vec<StagedItem> = Vec::with_capacity(active_requests.len());
    for req in &active_requests {
        let temp_name = format!(".sbfr_tmp_{}_{}", Uuid::new_v4().simple(), req.original_name);
        staged.push(StagedItem {
            original_name: req.original_name.clone(),
            temp_name: temp_name.clone(),
            target_name: req.target_name.clone(),
            orig_path: folder_path.join(&req.original_name),
            temp_path: folder_path.join(&temp_name),
            target_path: folder_path.join(&req.target_name),
        });
    }

    // Phase 1: Move original -> temp
    let mut phase1_done: Vec<usize> = Vec::new();
    for (idx, item) in staged.iter().enumerate() {
        if let Err(e) = fs::rename(&item.orig_path, &item.temp_path) {
            // Rollback Phase 1
            for &done_idx in phase1_done.iter().rev() {
                let _ = fs::rename(&staged[done_idx].temp_path, &staged[done_idx].orig_path);
            }
            return BatchRenameResult {
                success: false,
                renamed_count: 0,
                batch: None,
                errors: vec![format!(
                    "Failed staging '{}' for rename: {}. All changes rolled back.",
                    item.original_name, e
                )],
            };
        }
        phase1_done.push(idx);
    }

    // Phase 2: Move temp -> target (ensuring target does not exist)
    let mut phase2_done: Vec<usize> = Vec::new();
    for (idx, item) in staged.iter().enumerate() {
        if item.target_path.exists() {
            // Rollback Phase 2 and Phase 1
            for &done_idx in phase2_done.iter().rev() {
                let _ = fs::rename(&staged[done_idx].target_path, &staged[done_idx].temp_path);
            }
            for s in staged.iter().rev() {
                let _ = fs::rename(&s.temp_path, &s.orig_path);
            }
            return BatchRenameResult {
                success: false,
                renamed_count: 0,
                batch: None,
                errors: vec![format!(
                    "Refusing to overwrite existing file '{}'. All changes rolled back.",
                    item.target_name
                )],
            };
        }

        if let Err(e) = fs::rename(&item.temp_path, &item.target_path) {
            for &done_idx in phase2_done.iter().rev() {
                let _ = fs::rename(&staged[done_idx].target_path, &staged[done_idx].temp_path);
            }
            for s in staged.iter().rev() {
                let _ = fs::rename(&s.temp_path, &s.orig_path);
            }
            return BatchRenameResult {
                success: false,
                renamed_count: 0,
                batch: None,
                errors: vec![format!(
                    "Failed renaming to '{}': {}. All changes rolled back.",
                    item.target_name, e
                )],
            };
        }
        phase2_done.push(idx);
    }

    let operations: Vec<RenameOperationRecord> = staged
        .into_iter()
        .map(|s| RenameOperationRecord {
            original_name: s.original_name,
            new_name: s.target_name,
        })
        .collect();

    let batch = RenameBatchRecord {
        batch_id: Uuid::new_v4().to_string(),
        folder_path: folder_path.to_string_lossy().to_string(),
        timestamp: Utc::now().to_rfc3339(),
        operations: operations.clone(),
    };

    BatchRenameResult {
        success: true,
        renamed_count: operations.len(),
        batch: Some(batch),
        errors: Vec::new(),
    }
}

pub fn undo_batch_rename(batch: &RenameBatchRecord) -> BatchRenameResult {
    let folder_path = Path::new(&batch.folder_path);
    let reverse_requests: Vec<RenameRequestItem> = batch
        .operations
        .iter()
        .rev()
        .map(|op| RenameRequestItem {
            original_name: op.new_name.clone(),
            target_name: op.original_name.clone(),
        })
        .collect();

    execute_batch_rename(folder_path, &reverse_requests)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_trigger_batch_scan_and_rename_and_undo() {
        let dir = tempdir().unwrap();
        let files = [
            "Trigger.S01E01.x265.720p.WEB-EDITH.mkv",
            "Trigger.S01E02.x265.720p.WEB-EDITH.mkv",
            "Trigger.S01E03.x265.720p.WEB-EDITH.mkv",
            "Trigger.S01E04.x265.720p.WEB-EDITH.mkv",
        ];

        for f in &files {
            fs::write(dir.path().join(f), b"dummy video content").unwrap();
        }

        let scanned = scan_directory(dir.path(), false).unwrap();
        assert_eq!(scanned.len(), 4);

        let requests: Vec<RenameRequestItem> = scanned
            .iter()
            .map(|item| RenameRequestItem {
                original_name: item.original_name.clone(),
                target_name: item.parsed.suggested_name.clone(),
            })
            .collect();

        let res = execute_batch_rename(dir.path(), &requests);
        assert!(res.success, "Batch rename failed: {:?}", res.errors);
        assert_eq!(res.renamed_count, 4);

        for ep in 1..=4 {
            let expected = format!("Trigger S01E0{}.mkv", ep);
            assert!(dir.path().join(&expected).exists(), "Expected {} to exist", expected);
        }

        // Now test Undo
        let batch_record = res.batch.unwrap();
        let undo_res = undo_batch_rename(&batch_record);
        assert!(undo_res.success, "Undo failed: {:?}", undo_res.errors);
        assert_eq!(undo_res.renamed_count, 4);

        for f in &files {
            assert!(dir.path().join(f).exists(), "Expected original {} to be restored", f);
        }
    }

    #[test]
    fn test_case_only_rename_windows_compatibility() {
        let dir = tempdir().unwrap();
        let orig = "trigger s01e01.mkv";
        fs::write(dir.path().join(orig), b"video").unwrap();

        let requests = vec![RenameRequestItem {
            original_name: orig.to_string(),
            target_name: "Trigger S01E01.mkv".to_string(),
        }];

        let res = execute_batch_rename(dir.path(), &requests);
        assert!(res.success, "Case-only rename failed: {:?}", res.errors);
        assert_eq!(res.renamed_count, 1);

        let entries: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(entries, vec!["Trigger S01E01.mkv".to_string()]);
    }

    #[test]
    fn test_duplicate_destination_detection() {
        let dir = tempdir().unwrap();
        let f1 = "Trigger.S01E01.720p.mkv";
        let f2 = "Trigger.S01E01.1080p.mkv";
        fs::write(dir.path().join(f1), b"v1").unwrap();
        fs::write(dir.path().join(f2), b"v2").unwrap();

        let scanned = scan_directory(dir.path(), false).unwrap();
        assert_eq!(scanned.len(), 2);
        assert_eq!(scanned[0].parsed.status, RecognitionStatus::DuplicateTarget);
        assert_eq!(scanned[1].parsed.status, RecognitionStatus::DuplicateTarget);

        let requests = vec![
            RenameRequestItem {
                original_name: f1.to_string(),
                target_name: "Trigger S01E01.mkv".to_string(),
            },
            RenameRequestItem {
                original_name: f2.to_string(),
                target_name: "Trigger S01E01.mkv".to_string(),
            },
        ];

        let res = execute_batch_rename(dir.path(), &requests);
        assert!(!res.success);
        assert!(!res.errors.is_empty());
    }

    #[test]
    fn test_never_overwrite_existing_file_conflict() {
        let dir = tempdir().unwrap();
        let existing = "Trigger S01E01.mkv";
        let incoming = "Trigger.S01E01.1080p.WEB-DL.mkv";
        fs::write(dir.path().join(existing), b"existing content").unwrap();
        fs::write(dir.path().join(incoming), b"incoming content").unwrap();

        let requests = vec![RenameRequestItem {
            original_name: incoming.to_string(),
            target_name: existing.to_string(),
        }];

        let res = execute_batch_rename(dir.path(), &requests);
        assert!(!res.success);
        assert_eq!(
            fs::read_to_string(dir.path().join(existing)).unwrap(),
            "existing content"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join(incoming)).unwrap(),
            "incoming content"
        );
    }
}
