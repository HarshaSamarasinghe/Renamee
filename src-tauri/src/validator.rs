use crate::formatter::split_stem_and_extension;
use crate::models::{
    FileEntry, FileIdentitySnapshot, FileStatus, ValidationResult,
};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;
use uuid::Uuid;

const WINDOWS_RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

const MAX_WINDOWS_FILENAME_LEN: usize = 255;

pub fn validate_windows_basename_strict(
    proposed_name: &str,
    expected_extension: &str,
) -> Vec<String> {
    let mut errors = Vec::new();

    if proposed_name.trim().is_empty() {
        errors.push("Proposed filename cannot be empty".to_string());
        return errors;
    }

    // FR-18 & T26: Reject path separators and traversal
    if proposed_name.contains('/')
        || proposed_name.contains('\\')
        || proposed_name.contains("..")
    {
        errors.push(
            "Path separators (/ or \\) and traversal (..) are forbidden in filenames".to_string(),
        );
    }

    // FR-17 & T22: Trailing space or period
    if proposed_name.ends_with(' ') || proposed_name.ends_with('.') {
        errors.push("Windows filenames cannot end with a trailing space or period".to_string());
    }

    // FR-17 & T21: Illegal characters and ASCII control chars
    let illegal = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    if proposed_name
        .chars()
        .any(|c| illegal.contains(&c) || (c as u32) < 32)
    {
        errors.push(
            "Contains invalid Windows filename characters (< > : \" / \\ | ? *)".to_string(),
        );
    }

    // T40: Boundary length check
    if proposed_name.chars().count() > MAX_WINDOWS_FILENAME_LEN {
        errors.push(format!(
            "Filename exceeds maximum length of {} characters",
            MAX_WINDOWS_FILENAME_LEN
        ));
    }

    let (stem, ext) = split_stem_and_extension(proposed_name);
    if stem.trim().is_empty() {
        errors.push("Filename stem before extension cannot be empty".to_string());
    } else {
        let bare_device = stem
            .split('.')
            .next()
            .unwrap_or("")
            .trim()
            .to_uppercase();
        if WINDOWS_RESERVED_NAMES.contains(&bare_device.as_str()) {
            errors.push(format!("'{}' is a reserved Windows device name", stem));
        }
    }

    if !expected_extension.is_empty() && ext != expected_extension {
        errors.push(format!(
            "Extension must remain '{}' (found '{}')",
            expected_extension,
            if ext.is_empty() { "none" } else { &ext }
        ));
    }

    errors
}

pub fn read_current_snapshot(path: &Path) -> Result<FileIdentitySnapshot, String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|e| format!("Source file '{}' is missing or inaccessible: {}", path.display(), e))?;

    if meta.file_type().is_symlink() {
        return Err(format!("Symlinks are not supported: '{}'", path.display()));
    }
    if !meta.is_file() {
        return Err(format!("Path is not a regular file: '{}'", path.display()));
    }

    let size_bytes = meta.len();
    let modified_at_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let is_read_only = meta.permissions().readonly();

    Ok(FileIdentitySnapshot {
        size_bytes,
        modified_at_ms,
        is_read_only,
    })
}

/// Authoritative native preflight validation (Section 6 of Implementation Plan).
/// Re-verifies every file on disk, checks snapshot identity, detects batch duplicates and
/// external disk collisions, and returns a ValidationResult with a confirmation_token if valid.
pub fn run_native_preflight(mut entries: Vec<FileEntry>) -> ValidationResult {
    let plan_id = Uuid::new_v4().to_string();
    let mut blocking_errors: Vec<String> = Vec::new();

    // Build case-insensitive destination counts and active source keys for selected items
    let mut dest_counts: HashMap<String, usize> = HashMap::new();
    let mut active_source_keys: HashSet<String> = HashSet::new();

    for entry in &entries {
        if entry.selected {
            if let Some(ref proposed) = entry.proposed_name {
                let dir_lower = entry.directory.to_lowercase();
                let dest_key = format!("{}\\{}", dir_lower, proposed.to_lowercase());
                *dest_counts.entry(dest_key).or_insert(0) += 1;

                if proposed != &entry.original_name {
                    let orig_key =
                        format!("{}\\{}", dir_lower, entry.original_name.to_lowercase());
                    active_source_keys.insert(orig_key);
                }
            }
        }
    }

    let mut ready_count = 0;

    for entry in &mut entries {
        entry.issues.clear();

        let proposed = match entry.proposed_name.clone() {
            Some(p) => p,
            None => {
                entry.selected = false;
                entry.status = FileStatus::NeedsReview;
                entry
                    .issues
                    .push("Unrecognized or ambiguous filename".to_string());
                continue;
            }
        };

        let syntax_errors = validate_windows_basename_strict(&proposed, &entry.extension);
        if !syntax_errors.is_empty() {
            entry.status = FileStatus::Conflict;
            for err in &syntax_errors {
                blocking_errors.push(format!("{}: {}", entry.original_name, err));
            }
            entry.issues = syntax_errors;
            continue;
        }

        if !entry.selected {
            entry.status = FileStatus::Skipped;
            continue;
        }

        // T18: Exact no-op rename
        if proposed == entry.original_name {
            entry.selected = false;
            entry.status = FileStatus::Skipped;
            entry
                .issues
                .push("Filename is already clean (unchanged)".to_string());
            continue;
        }

        let src_path = Path::new(&entry.source_path);
        let parent_dir = match src_path.parent() {
            Some(p) => p,
            None => {
                let msg = format!("Invalid source path '{}'", entry.source_path);
                entry.status = FileStatus::Conflict;
                entry.issues.push(msg.clone());
                blocking_errors.push(msg);
                continue;
            }
        };

        // Ensure target stays inside exact same parent directory (FR-18, T26)
        let dst_path = parent_dir.join(&proposed);
        if dst_path.parent() != Some(parent_dir) {
            let msg = format!(
                "Cross-directory target rejected for '{}'",
                entry.original_name
            );
            entry.status = FileStatus::Conflict;
            entry.issues.push(msg.clone());
            blocking_errors.push(msg);
            continue;
        }

        // T23 & T24: Verify source exists on disk and matches snapshot
        match read_current_snapshot(src_path) {
            Ok(current_snap) => {
                if current_snap.size_bytes != entry.identity_snapshot.size_bytes
                    || (entry.identity_snapshot.modified_at_ms > 0
                        && current_snap.modified_at_ms != entry.identity_snapshot.modified_at_ms)
                {
                    let msg = format!(
                        "Source file '{}' changed on disk since scan; please rescan",
                        entry.original_name
                    );
                    entry.status = FileStatus::Conflict;
                    entry.issues.push(msg.clone());
                    blocking_errors.push(msg);
                    continue;
                }
            }
            Err(err) => {
                entry.status = FileStatus::Conflict;
                entry.issues.push(err.clone());
                blocking_errors.push(err);
                continue;
            }
        }

        let dir_lower = entry.directory.to_lowercase();
        let orig_key = format!("{}\\{}", dir_lower, entry.original_name.to_lowercase());
        let dest_key = format!("{}\\{}", dir_lower, proposed.to_lowercase());

        // T16: Duplicate destination within batch
        if dest_counts.get(&dest_key).copied().unwrap_or(0) > 1 {
            let msg = format!(
                "Duplicate destination '{}' in batch",
                proposed
            );
            entry.status = FileStatus::Conflict;
            entry.issues.push(msg.clone());
            blocking_errors.push(format!("{}: {}", entry.original_name, msg));
            continue;
        }

        // T17 & T25: Check if destination already exists on disk (and is not a case-only self-rename or part of an active batch swap)
        let is_case_only_self = orig_key == dest_key;
        if !is_case_only_self && dst_path.exists() && !active_source_keys.contains(&dest_key) {
            let msg = format!(
                "Target file '{}' already exists on disk and will never be overwritten",
                proposed
            );
            entry.status = FileStatus::Conflict;
            entry.issues.push(msg.clone());
            blocking_errors.push(format!("{}: {}", entry.original_name, msg));
            continue;
        }

        entry.status = FileStatus::Ready;
        ready_count += 1;
    }

    let valid = blocking_errors.is_empty() && ready_count > 0;
    let confirmation_token = if valid {
        Some(format!("confirm_{}_{}", plan_id, Uuid::new_v4().simple()))
    } else {
        None
    };

    ValidationResult {
        plan_id,
        valid,
        confirmation_token,
        entries,
        blocking_errors,
    }
}
