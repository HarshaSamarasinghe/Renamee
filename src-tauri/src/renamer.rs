use crate::journal::upsert_journal_record;
use crate::models::{
    BatchResult, FileEntry, FileStatus, RenameOutcome, RenameResultItem, UndoRecord, UndoStepRecord,
};
use crate::parser::{parse_filename, validate_windows_filename, ParsedFilename, RecognitionStatus};
use crate::validator::{read_current_snapshot, run_native_preflight};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

// ============================================================================
// PHASE 5: STAGED COLLISION-AWARE NATIVE RENAMER WITH PERSISTENT JOURNAL
// ============================================================================

pub fn execute_validated_plan_with_journal(
    entries: Vec<FileEntry>,
    journal_file: &Path,
) -> BatchResult {
    let operation_id = Uuid::new_v4().to_string();
    let timestamp = Utc::now().to_rfc3339();

    // 1. Run authoritative native preflight immediately before any mutation
    let preflight = run_native_preflight(entries);
    if !preflight.valid {
        let results: Vec<RenameResultItem> = preflight
            .entries
            .into_iter()
            .filter(|e| e.status == FileStatus::Conflict)
            .map(|e| RenameResultItem {
                file_id: e.id,
                from_path: e.source_path.clone(),
                to_path: e
                    .proposed_name
                    .as_ref()
                    .map(|p| format!("{}\\{}", e.directory, p))
                    .unwrap_or_else(|| e.source_path.clone()),
                outcome: RenameOutcome::Failed,
                error_code: Some("PREFLIGHT_CONFLICT".to_string()),
                message: Some(e.issues.join("; ")),
            })
            .collect();

        let failed_count = results.len();
        return BatchResult {
            operation_id,
            timestamp,
            results,
            renamed_count: 0,
            unchanged_count: 0,
            skipped_count: 0,
            failed_count,
            can_undo: false,
            summary_message: format!(
                "Preflight validation blocked execution ({} issue(s)): {}",
                preflight.blocking_errors.len(),
                preflight.blocking_errors.join(" | ")
            ),
        };
    }

    struct StagedPlanStep {
        file_id: String,
        source_path: PathBuf,
        temp_path: PathBuf,
        final_path: PathBuf,
        original_name: String,
        proposed_name: String,
    }

    let mut staged_steps: Vec<StagedPlanStep> = Vec::new();
    let mut skipped_count = 0;
    let mut unchanged_count = 0;
    let mut results: Vec<RenameResultItem> = Vec::new();

    for entry in &preflight.entries {
        if entry.status != FileStatus::Ready || !entry.selected {
            if entry.proposed_name.as_deref() == Some(entry.original_name.as_str()) {
                unchanged_count += 1;
                results.push(RenameResultItem {
                    file_id: entry.id.clone(),
                    from_path: entry.source_path.clone(),
                    to_path: entry.source_path.clone(),
                    outcome: RenameOutcome::Unchanged,
                    error_code: None,
                    message: None,
                });
            } else {
                skipped_count += 1;
            }
            continue;
        }

        let proposed = match &entry.proposed_name {
            Some(p) => p.clone(),
            None => {
                skipped_count += 1;
                continue;
            }
        };

        let src_path = PathBuf::from(&entry.source_path);
        let parent_dir = match src_path.parent() {
            Some(p) => p,
            None => continue,
        };

        // Reserve a unique temporary filename in the SAME directory and verify it doesn't exist
        let mut temp_path = parent_dir.join(format!(
            ".sbfr_tmp_{}_{}",
            Uuid::new_v4().simple(),
            entry.original_name
        ));
        while temp_path.exists() {
            temp_path = parent_dir.join(format!(
                ".sbfr_tmp_{}_{}",
                Uuid::new_v4().simple(),
                entry.original_name
            ));
        }

        let final_path = parent_dir.join(&proposed);
        staged_steps.push(StagedPlanStep {
            file_id: entry.id.clone(),
            source_path: src_path,
            temp_path,
            final_path,
            original_name: entry.original_name.clone(),
            proposed_name: proposed,
        });
    }

    if staged_steps.is_empty() {
        return BatchResult {
            operation_id,
            timestamp,
            results,
            renamed_count: 0,
            unchanged_count,
            skipped_count,
            failed_count: 0,
            can_undo: false,
            summary_message: "No files required renaming.".to_string(),
        };
    }

    // Write pre-stage journal ("incomplete_staged") so crash recovery can restore any .sbfr_tmp_* files
    let initial_undo_steps: Vec<UndoStepRecord> = staged_steps
        .iter()
        .map(|s| UndoStepRecord {
            file_id: s.file_id.clone(),
            original_path: s.source_path.to_string_lossy().to_string(),
            temp_path: Some(s.temp_path.to_string_lossy().to_string()),
            final_path: s.final_path.to_string_lossy().to_string(),
            post_rename_snapshot: crate::models::FileIdentitySnapshot {
                size_bytes: 0,
                modified_at_ms: 0,
                is_read_only: false,
            },
        })
        .collect();

    let _ = upsert_journal_record(
        journal_file,
        UndoRecord {
            operation_id: operation_id.clone(),
            timestamp: timestamp.clone(),
            successfully_completed_steps: initial_undo_steps,
            status: "incomplete_staged".to_string(),
        },
    );

    // STAGE 1: Move source -> reserved temporary filename in same directory
    let mut stage1_completed: Vec<usize> = Vec::new();
    for (idx, step) in staged_steps.iter().enumerate() {
        if let Err(e) = fs::rename(&step.source_path, &step.temp_path) {
            // Conservative rollback of Stage 1 without overwriting
            for &done_idx in stage1_completed.iter().rev() {
                let s = &staged_steps[done_idx];
                if !s.source_path.exists() {
                    let _ = fs::rename(&s.temp_path, &s.source_path);
                }
            }
            let _ = upsert_journal_record(
                journal_file,
                UndoRecord {
                    operation_id: operation_id.clone(),
                    timestamp: timestamp.clone(),
                    successfully_completed_steps: Vec::new(),
                    status: "undone".to_string(),
                },
            );

            results.push(RenameResultItem {
                file_id: step.file_id.clone(),
                from_path: step.source_path.to_string_lossy().to_string(),
                to_path: step.final_path.to_string_lossy().to_string(),
                outcome: RenameOutcome::Failed,
                error_code: Some("STAGE_FAILED".to_string()),
                message: Some(format!(
                    "Failed staging '{}': {}. Rolled back staged files.",
                    step.original_name, e
                )),
            });

            return BatchResult {
                operation_id,
                timestamp,
                results,
                renamed_count: 0,
                unchanged_count,
                skipped_count,
                failed_count: 1,
                can_undo: false,
                summary_message: format!(
                    "Aborted during staging of '{}'; all staged files were safely rolled back.",
                    step.original_name
                ),
            };
        }
        stage1_completed.push(idx);
    }

    // STAGE 2: Move reserved temporary filename -> final destination (rechecking destination does not exist)
    let mut completed_undo_steps: Vec<UndoStepRecord> = Vec::new();
    let mut stage2_completed: Vec<usize> = Vec::new();

    for (idx, step) in staged_steps.iter().enumerate() {
        // T25: Recheck immediately before final move that destination does not exist on disk
        if step.final_path.exists() {
            // Rollback Stage 2 and Stage 1 conservatively
            for &done_idx in stage2_completed.iter().rev() {
                let s = &staged_steps[done_idx];
                if !s.temp_path.exists() {
                    let _ = fs::rename(&s.final_path, &s.temp_path);
                }
            }
            for s in staged_steps.iter().rev() {
                if s.temp_path.exists() && !s.source_path.exists() {
                    let _ = fs::rename(&s.temp_path, &s.source_path);
                }
            }
            let _ = upsert_journal_record(
                journal_file,
                UndoRecord {
                    operation_id: operation_id.clone(),
                    timestamp: timestamp.clone(),
                    successfully_completed_steps: Vec::new(),
                    status: "undone".to_string(),
                },
            );

            results.push(RenameResultItem {
                file_id: step.file_id.clone(),
                from_path: step.source_path.to_string_lossy().to_string(),
                to_path: step.final_path.to_string_lossy().to_string(),
                outcome: RenameOutcome::Failed,
                error_code: Some("TARGET_APPEARED".to_string()),
                message: Some(format!(
                    "Target '{}' appeared before commit; rolled back batch to prevent overwrite.",
                    step.proposed_name
                )),
            });

            return BatchResult {
                operation_id,
                timestamp,
                results,
                renamed_count: 0,
                unchanged_count,
                skipped_count,
                failed_count: 1,
                can_undo: false,
                summary_message: format!(
                    "Target '{}' already existed; rolled back batch without overwriting.",
                    step.proposed_name
                ),
            };
        }

        match fs::rename(&step.temp_path, &step.final_path) {
            Ok(_) => {
                stage2_completed.push(idx);
                let post_snap = read_current_snapshot(&step.final_path).unwrap_or(
                    crate::models::FileIdentitySnapshot {
                        size_bytes: 0,
                        modified_at_ms: 0,
                        is_read_only: false,
                    },
                );
                completed_undo_steps.push(UndoStepRecord {
                    file_id: step.file_id.clone(),
                    original_path: step.source_path.to_string_lossy().to_string(),
                    temp_path: None,
                    final_path: step.final_path.to_string_lossy().to_string(),
                    post_rename_snapshot: post_snap,
                });
                results.push(RenameResultItem {
                    file_id: step.file_id.clone(),
                    from_path: step.source_path.to_string_lossy().to_string(),
                    to_path: step.final_path.to_string_lossy().to_string(),
                    outcome: RenameOutcome::Renamed,
                    error_code: None,
                    message: None,
                });
            }
            Err(e) => {
                // Rollback remaining temp files to their original names
                for s in staged_steps.iter().skip(idx) {
                    if s.temp_path.exists() && !s.source_path.exists() {
                        let _ = fs::rename(&s.temp_path, &s.source_path);
                    }
                }
                results.push(RenameResultItem {
                    file_id: step.file_id.clone(),
                    from_path: step.source_path.to_string_lossy().to_string(),
                    to_path: step.final_path.to_string_lossy().to_string(),
                    outcome: RenameOutcome::Failed,
                    error_code: Some("COMMIT_FAILED".to_string()),
                    message: Some(e.to_string()),
                });
                break;
            }
        }
    }

    let renamed_count = completed_undo_steps.len();
    let failed_count = results
        .iter()
        .filter(|r| r.outcome == RenameOutcome::Failed)
        .count();

    let status_str = if failed_count == 0 {
        "completed"
    } else {
        "partially_completed"
    };

    let _ = upsert_journal_record(
        journal_file,
        UndoRecord {
            operation_id: operation_id.clone(),
            timestamp: timestamp.clone(),
            successfully_completed_steps: completed_undo_steps,
            status: status_str.to_string(),
        },
    );

    BatchResult {
        operation_id,
        timestamp,
        results,
        renamed_count,
        unchanged_count,
        skipped_count,
        failed_count,
        can_undo: renamed_count > 0,
        summary_message: format!(
            "Renamed {} file(s) ({} unchanged, {} skipped, {} failed).",
            renamed_count, unchanged_count, skipped_count, failed_count
        ),
    }
}

// ============================================================================
// LEGACY ADAPTERS (Kept for backward compatibility with Phase 0 tests)
// ============================================================================

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
    if !folder_path.exists() || !folder_path.is_dir() {
        return Err(format!("Invalid directory: {}", folder_path.display()));
    }
    let entries = fs::read_dir(folder_path).map_err(|e| e.to_string())?;
    let mut existing_filenames_lower = HashSet::new();
    let mut raw_files = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if let Some(name_os) = path.file_name() {
                let name = name_os.to_string_lossy().to_string();
                existing_filenames_lower.insert(name.to_lowercase());
                let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
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

    let existing_entries = fs::read_dir(folder_path).map_err(|e| e.to_string())?;
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
                message: format!("Source file '{}' no longer exists", req.original_name),
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
        } else if target_lower != orig_lower
            && disk_files_lower.contains(&target_lower)
            && !source_set_lower.contains(&target_lower)
        {
            issues.push(ValidationIssue {
                original_name: req.original_name.clone(),
                target_name: req.target_name.clone(),
                status: RecognitionStatus::DiskConflict,
                message: format!("Target '{}' already exists", req.target_name),
            });
        }
    }
    Ok(issues)
}

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
            target_name: req.target_name.clone(),
            orig_path: folder_path.join(&req.original_name),
            temp_path: folder_path.join(&temp_name),
            target_path: folder_path.join(&req.target_name),
        });
    }

    let mut phase1_done: Vec<usize> = Vec::new();
    for (idx, item) in staged.iter().enumerate() {
        if let Err(e) = fs::rename(&item.orig_path, &item.temp_path) {
            for &done_idx in phase1_done.iter().rev() {
                let _ = fs::rename(&staged[done_idx].temp_path, &staged[done_idx].orig_path);
            }
            return BatchRenameResult {
                success: false,
                renamed_count: 0,
                batch: None,
                errors: vec![format!("Failed staging '{}': {}", item.original_name, e)],
            };
        }
        phase1_done.push(idx);
    }

    let mut phase2_done: Vec<usize> = Vec::new();
    for (idx, item) in staged.iter().enumerate() {
        if item.target_path.exists() {
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
                errors: vec![format!("Refusing to overwrite '{}'", item.target_name)],
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
                errors: vec![format!("Failed renaming to '{}': {}", item.target_name, e)],
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

    BatchRenameResult {
        success: true,
        renamed_count: operations.len(),
        batch: Some(RenameBatchRecord {
            batch_id: Uuid::new_v4().to_string(),
            folder_path: folder_path.to_string_lossy().to_string(),
            timestamp: Utc::now().to_rfc3339(),
            operations,
        }),
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
    use crate::journal::{execute_safe_undo, recover_incomplete_journals};
    use crate::scanner::scan_folder_native;
    use tempfile::tempdir;

    #[test]
    fn test_phase5_100_files_staged_rename_preserves_bytes_and_supports_undo() {
        let dir = tempdir().unwrap();
        let journal_path = dir.path().join("journal.json");

        for ep in 1..=100 {
            let filename = format!("Trigger.S01E{:02}.1080p.WEB-DL.x265.mkv", ep);
            let payload = format!("exact-video-bytes-for-episode-{}", ep);
            fs::write(dir.path().join(filename), payload.as_bytes()).unwrap();
        }

        let scanned = scan_folder_native(dir.path(), false, &[]).unwrap();
        assert_eq!(scanned.entries.len(), 100);

        let batch_res = execute_validated_plan_with_journal(scanned.entries, &journal_path);
        assert_eq!(batch_res.renamed_count, 100);
        assert_eq!(batch_res.failed_count, 0);

        // Verify all 100 files exist with exact content bytes preserved
        for ep in 1..=100 {
            let expected_name = format!("Trigger S01E{:02}.mkv", ep);
            let content = fs::read_to_string(dir.path().join(&expected_name)).unwrap();
            assert_eq!(content, format!("exact-video-bytes-for-episode-{}", ep));
        }

        // Now test Phase 6 Safe Undo on all 100 files
        let undo_res = execute_safe_undo(&journal_path, Some(&batch_res.operation_id)).unwrap();
        assert_eq!(undo_res.renamed_count, 100);
        assert_eq!(undo_res.failed_count, 0);

        for ep in 1..=100 {
            let orig_name = format!("Trigger.S01E{:02}.1080p.WEB-DL.x265.mkv", ep);
            let content = fs::read_to_string(dir.path().join(&orig_name)).unwrap();
            assert_eq!(content, format!("exact-video-bytes-for-episode-{}", ep));
        }
    }

    #[test]
    fn test_phase6_undo_blocks_when_file_replaced_or_original_occupied() {
        let dir = tempdir().unwrap();
        let journal_path = dir.path().join("journal.json");
        let orig = "Trigger.S01E01.720p.mkv";
        fs::write(dir.path().join(orig), b"original-bytes-123").unwrap();

        let scanned = scan_folder_native(dir.path(), false, &[]).unwrap();
        let batch_res = execute_validated_plan_with_journal(scanned.entries, &journal_path);
        assert_eq!(batch_res.renamed_count, 1);

        // Simulate external modification of the renamed file (T35)
        fs::write(
            dir.path().join("Trigger S01E01.mkv"),
            b"externally-modified-different-length-bytes",
        )
        .unwrap();

        let undo_res = execute_safe_undo(&journal_path, Some(&batch_res.operation_id)).unwrap();
        assert_eq!(undo_res.renamed_count, 0);
        assert_eq!(undo_res.failed_count, 1);
    }

    #[test]
    fn test_phase6_crash_recovery_from_incomplete_staged_journal() {
        let dir = tempdir().unwrap();
        let journal_path = dir.path().join("journal.json");

        let orig_path = dir.path().join("Trigger.S01E01.mkv");
        let temp_path = dir.path().join(".sbfr_tmp_crash_Trigger.S01E01.mkv");
        let final_path = dir.path().join("Trigger S01E01.mkv");

        // Simulate crash after Stage 1 (file is sitting at temp_path)
        fs::write(&temp_path, b"precious-media-bytes").unwrap();

        upsert_journal_record(
            &journal_path,
            UndoRecord {
                operation_id: "op-crash-1".to_string(),
                timestamp: Utc::now().to_rfc3339(),
                successfully_completed_steps: vec![UndoStepRecord {
                    file_id: "f1".to_string(),
                    original_path: orig_path.to_string_lossy().to_string(),
                    temp_path: Some(temp_path.to_string_lossy().to_string()),
                    final_path: final_path.to_string_lossy().to_string(),
                    post_rename_snapshot: crate::models::FileIdentitySnapshot {
                        size_bytes: 20,
                        modified_at_ms: 0,
                        is_read_only: false,
                    },
                }],
                status: "incomplete_staged".to_string(),
            },
        )
        .unwrap();

        let recovered = recover_incomplete_journals(&journal_path).unwrap();
        assert_eq!(recovered, 1);
        assert!(orig_path.exists());
        assert_eq!(
            fs::read_to_string(&orig_path).unwrap(),
            "precious-media-bytes"
        );
    }
}
