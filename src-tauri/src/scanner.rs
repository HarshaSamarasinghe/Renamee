use crate::formatter::{
    format_episode_filename, get_series_season_group_key, split_stem_and_extension, DEFAULT_PATTERN,
};
use crate::models::{
    FileEntry, FileIdentitySnapshot, FileStatus, PreviewOverrides, PreviewResult,
};
use crate::parser::analyze_filename;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use uuid::Uuid;

pub const DEFAULT_SUPPORTED_EXTENSIONS: &[&str] = &[
    ".mkv", ".mp4", ".avi", ".mov", ".wmv", ".m4v",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanFolderResponse {
    pub entries: Vec<FileEntry>,
    pub scan_errors: Vec<String>,
    pub scanned_folder: String,
    pub recursive: bool,
}

pub fn normalize_supported_extensions(exts: &[String]) -> Vec<String> {
    if exts.is_empty() {
        return DEFAULT_SUPPORTED_EXTENSIONS
            .iter()
            .map(|s| s.to_lowercase())
            .collect();
    }
    exts.iter()
        .map(|e| {
            let trimmed = e.trim().to_lowercase();
            if trimmed.starts_with('.') {
                trimmed
            } else {
                format!(".{}", trimmed)
            }
        })
        .collect()
}

pub fn has_supported_extension(filename: &str, allowed_lower: &[String]) -> bool {
    if allowed_lower.iter().any(|e| e == "*" || e == ".*") {
        return true;
    }
    let (_, ext) = split_stem_and_extension(filename);
    if ext.is_empty() {
        return false;
    }
    let ext_lower = ext.to_lowercase();
    allowed_lower.iter().any(|allowed| allowed == &ext_lower)
}

fn inspect_file_entry(path: &Path) -> Result<FileEntry, String> {
    let symlink_meta = fs::symlink_metadata(path).map_err(|e| {
        format!(
            "Cannot read metadata for '{}': {}",
            path.display(),
            e
        )
    })?;

    if symlink_meta.file_type().is_symlink() {
        return Err(format!(
            "Skipping symlink '{}' for safety",
            path.display()
        ));
    }

    if !symlink_meta.is_file() {
        return Err(format!("'{}' is not a regular file", path.display()));
    }

    let original_name = path
        .file_name()
        .ok_or_else(|| format!("Invalid file name in '{}'", path.display()))?
        .to_string_lossy()
        .to_string();

    let directory = path
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let size_bytes = symlink_meta.len();
    let modified_at_ms = symlink_meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let is_read_only = symlink_meta.permissions().readonly();

    let snapshot = FileIdentitySnapshot {
        size_bytes,
        modified_at_ms,
        is_read_only,
    };

    let analysis = analyze_filename(&original_name, DEFAULT_PATTERN);
    let (status, selected) = if analysis.needs_review || analysis.parsed.is_none() {
        (FileStatus::NeedsReview, false)
    } else if analysis.proposed_name.as_deref() == Some(original_name.as_str()) {
        (FileStatus::Skipped, false)
    } else {
        (FileStatus::Ready, true)
    };

    Ok(FileEntry {
        id: Uuid::new_v4().to_string(),
        source_path: path.to_string_lossy().to_string(),
        directory,
        original_name,
        stem: analysis.stem,
        extension: analysis.extension,
        size_bytes,
        modified_at: modified_at_ms,
        identity_snapshot: snapshot,
        parsed: analysis.parsed,
        proposed_name: analysis.proposed_name,
        selected,
        status,
        issues: analysis.issues,
        manual_edited_name: None,
    })
}

fn collect_files_from_dir(
    dir: &Path,
    recursive: bool,
    allowed_lower: &[String],
    entries: &mut Vec<FileEntry>,
    errors: &mut Vec<String>,
) {
    let read_dir = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) => {
            errors.push(format!("Unable to read directory '{}': {}", dir.display(), e));
            return;
        }
    };

    let mut subdirs: Vec<PathBuf> = Vec::new();
    let mut files: Vec<PathBuf> = Vec::new();

    for item in read_dir {
        match item {
            Ok(dir_entry) => {
                let path = dir_entry.path();
                match fs::symlink_metadata(&path) {
                    Ok(meta) => {
                        if meta.file_type().is_symlink() {
                            continue;
                        }
                        if meta.is_dir() && recursive {
                            subdirs.push(path);
                        } else if meta.is_file() {
                            if let Some(name) = path.file_name() {
                                let name_str = name.to_string_lossy();
                                if has_supported_extension(&name_str, allowed_lower) {
                                    files.push(path);
                                }
                            }
                        }
                    }
                    Err(e) => {
                        errors.push(format!("Failed reading '{}': {}", path.display(), e));
                    }
                }
            }
            Err(e) => {
                errors.push(format!("Directory entry error in '{}': {}", dir.display(), e));
            }
        }
    }

    // Sort for deterministic display order only (never alters episode numbers)
    files.sort_by(|a, b| {
        a.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase()
            .cmp(
                &b.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase(),
            )
    });
    subdirs.sort();

    for file_path in files {
        match inspect_file_entry(&file_path) {
            Ok(entry) => entries.push(entry),
            Err(err) => errors.push(err),
        }
    }

    if recursive {
        for subdir in subdirs {
            collect_files_from_dir(&subdir, true, allowed_lower, entries, errors);
        }
    }
}

pub fn scan_folder_native(
    folder_path: &Path,
    recursive: bool,
    supported_extensions: &[String],
) -> Result<ScanFolderResponse, String> {
    if !folder_path.exists() {
        return Err(format!("Folder does not exist: {}", folder_path.display()));
    }
    if !folder_path.is_dir() {
        return Err(format!(
            "Selected path is not a folder: {}",
            folder_path.display()
        ));
    }

    let allowed_lower = normalize_supported_extensions(supported_extensions);
    let mut entries = Vec::new();
    let mut scan_errors = Vec::new();

    collect_files_from_dir(
        folder_path,
        recursive,
        &allowed_lower,
        &mut entries,
        &mut scan_errors,
    );

    Ok(ScanFolderResponse {
        entries,
        scan_errors,
        scanned_folder: folder_path.to_string_lossy().to_string(),
        recursive,
    })
}

pub fn scan_arbitrary_paths_native(
    paths: &[String],
    recursive: bool,
    supported_extensions: &[String],
) -> Result<ScanFolderResponse, String> {
    let allowed_lower = normalize_supported_extensions(supported_extensions);
    let mut entries = Vec::new();
    let mut scan_errors = Vec::new();
    let mut seen_paths: HashSet<String> = HashSet::new();

    for raw in paths {
        let p = Path::new(raw);
        if !p.exists() {
            scan_errors.push(format!("Path does not exist: {}", raw));
            continue;
        }
        if p.is_dir() {
            let mut dir_entries = Vec::new();
            collect_files_from_dir(
                p,
                recursive,
                &allowed_lower,
                &mut dir_entries,
                &mut scan_errors,
            );
            for e in dir_entries {
                let key = e.source_path.to_lowercase();
                if seen_paths.insert(key) {
                    entries.push(e);
                }
            }
        } else if p.is_file() {
            let key = raw.to_lowercase();
            if seen_paths.insert(key) {
                match inspect_file_entry(p) {
                    Ok(entry) => entries.push(entry),
                    Err(e) => scan_errors.push(e),
                }
            }
        }
    }

    let scanned_folder = paths.first().cloned().unwrap_or_default();
    Ok(ScanFolderResponse {
        entries,
        scan_errors,
        scanned_folder,
        recursive,
    })
}

pub fn build_preview_result(
    entries: Vec<FileEntry>,
    overrides: &PreviewOverrides,
) -> PreviewResult {
    let excluded_set: HashSet<&str> = overrides
        .excluded_ids
        .iter()
        .map(|s| s.as_str())
        .collect();
    let pattern = if overrides.pattern.trim().is_empty() {
        DEFAULT_PATTERN
    } else {
        overrides.pattern.as_str()
    };

    let mut updated_entries = Vec::with_capacity(entries.len());
    let mut ready_count = 0;
    let mut needs_review_count = 0;
    let mut conflict_count = 0;
    let mut skipped_count = 0;

    for mut entry in entries {
        let is_selected = !excluded_set.contains(entry.id.as_str());

        if let Some(manual_name) = overrides.manual_row_names.get(&entry.id) {
            let trimmed = manual_name.trim();
            if !trimmed.is_empty() {
                let final_manual = if !entry.extension.is_empty()
                    && !trimmed.ends_with(&entry.extension)
                {
                    let (manual_stem, _) = split_stem_and_extension(trimmed);
                    format!("{}{}", manual_stem, entry.extension)
                } else {
                    trimmed.to_string()
                };

                entry.manual_edited_name = Some(final_manual.clone());
                entry.proposed_name = Some(final_manual.clone());
                entry.selected = is_selected;
                entry.issues.clear();

                if !is_selected || final_manual == entry.original_name {
                    entry.status = FileStatus::Skipped;
                    skipped_count += 1;
                } else {
                    entry.status = FileStatus::Ready;
                    ready_count += 1;
                }
                updated_entries.push(entry);
                continue;
            }
        }

        let analysis = analyze_filename(&entry.original_name, pattern);
        if analysis.needs_review || analysis.parsed.is_none() {
            entry.parsed = None;
            entry.proposed_name = None;
            entry.selected = false;
            entry.status = FileStatus::NeedsReview;
            entry.issues = analysis.issues;
            needs_review_count += 1;
            updated_entries.push(entry);
            continue;
        }

        let mut parsed_ep = analysis.parsed.unwrap();
        let group_key = get_series_season_group_key(&parsed_ep);
        if let Some(override_series) = overrides.series_overrides.get(&group_key) {
            if !override_series.trim().is_empty() {
                parsed_ep.series = override_series.trim().to_string();
            }
        }

        let proposed = format_episode_filename(
            &parsed_ep.series,
            parsed_ep.season,
            parsed_ep.episode,
            &entry.extension,
            pattern,
        );

        entry.parsed = Some(parsed_ep);
        entry.proposed_name = Some(proposed.clone());
        entry.selected = is_selected;
        entry.issues.clear();

        if !is_selected || proposed == entry.original_name {
            entry.status = FileStatus::Skipped;
            skipped_count += 1;
        } else {
            entry.status = FileStatus::Ready;
            ready_count += 1;
        }

        if entry.status == FileStatus::Conflict {
            conflict_count += 1;
        }

        updated_entries.push(entry);
    }

    PreviewResult {
        entries: updated_entries,
        plan_id: Uuid::new_v4().to_string(),
        ready_count,
        needs_review_count,
        conflict_count,
        skipped_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_phase2_scan_folder_filtering_and_recursion() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("Trigger.S01E01.x265.720p.WEB-EDITH.mkv"),
            b"ep1",
        )
        .unwrap();
        fs::write(
            dir.path().join("Trigger.S01.E10.x265.720p-WEB-randomvideo.mkv"),
            b"ep10",
        )
        .unwrap();
        fs::write(dir.path().join("notes.txt"), b"ignore me").unwrap();

        let sub = dir.path().join("Season 2");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("Trigger.S02E01.1080p.mp4"), b"s2e1").unwrap();

        // Non-recursive scan (default)
        let non_rec = scan_folder_native(dir.path(), false, &[]).unwrap();
        assert_eq!(non_rec.entries.len(), 2);
        assert_eq!(
            non_rec.entries[0].proposed_name.as_deref(),
            Some("Trigger S01E10.mkv")
        );
        assert_eq!(
            non_rec.entries[1].proposed_name.as_deref(),
            Some("Trigger S01E01.mkv")
        );

        // Recursive scan
        let rec = scan_folder_native(dir.path(), true, &[]).unwrap();
        assert_eq!(rec.entries.len(), 3);
    }
}
