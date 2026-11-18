use crate::models::{
    BatchResult, RenameOutcome, RenameResultItem, UndoRecord,
};
use crate::validator::read_current_snapshot;
use chrono::Utc;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub fn default_journal_path() -> PathBuf {
    let base = std::env::temp_dir().join("SmartBulkFileRenamer_AppData");
    let _ = fs::create_dir_all(&base);
    base.join("rename_journal.json")
}

pub fn load_journal_from_file(journal_file: &Path) -> Vec<UndoRecord> {
    if !journal_file.exists() {
        return Vec::new();
    }
    match fs::read_to_string(journal_file) {
        Ok(content) => serde_json::from_str::<Vec<UndoRecord>>(&content).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

pub fn save_journal_to_file(journal_file: &Path, records: &[UndoRecord]) -> Result<(), String> {
    if let Some(parent) = journal_file.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed creating journal directory: {}", e))?;
    }
    let serialized = serde_json::to_string_pretty(records)
        .map_err(|e| format!("Failed serializing journal: {}", e))?;
    fs::write(journal_file, serialized)
        .map_err(|e| format!("Failed writing journal file: {}", e))
}

pub fn upsert_journal_record(journal_file: &Path, record: UndoRecord) -> Result<(), String> {
    let mut records = load_journal_from_file(journal_file);
    if let Some(existing) = records
        .iter_mut()
        .find(|r| r.operation_id == record.operation_id)
    {
        *existing = record;
    } else {
        records.push(record);
    }
    save_journal_to_file(journal_file, &records)
}

/// T32: Detects and safely recovers any interrupted `"incomplete_staged"` batches
/// where the application crashed while files were at their `.sbfr_tmp_*` paths.
/// Never overwrites any existing file during recovery.
pub fn recover_incomplete_journals(journal_file: &Path) -> Result<usize, String> {
    let mut records = load_journal_from_file(journal_file);
    let mut recovered_files = 0;
    let mut modified = false;

    for record in records.iter_mut() {
        if record.status != "incomplete_staged" {
            continue;
        }

        for step in record.successfully_completed_steps.iter().rev() {
            let orig_path = Path::new(&step.original_path);
            let final_path = Path::new(&step.final_path);

            if let Some(ref temp_str) = step.temp_path {
                let temp_path = Path::new(temp_str);
                if temp_path.exists() && !orig_path.exists() {
                    if fs::rename(temp_path, orig_path).is_ok() {
                        recovered_files += 1;
                    }
                } else if final_path.exists() && !orig_path.exists() {
                    if fs::rename(final_path, orig_path).is_ok() {
                        recovered_files += 1;
                    }
                }
            }
        }

        record.status = "undone".to_string();
        modified = true;
    }

    if modified {
        save_journal_to_file(journal_file, &records)?;
    }

    Ok(recovered_files)
}

/// Phase 6 (T33, T34, T35): Safely undoes a completed batch from the persistent journal.
/// - Verifies each renamed file still exists and matches its `post_rename_snapshot` (T35).
/// - Verifies the original destination path is not occupied by an unrelated file (T34).
/// - Stages through unique temporary filenames in the same directory so swaps and case-only renames undo cleanly.
pub fn execute_safe_undo(
    journal_file: &Path,
    target_operation_id: Option<&str>,
) -> Result<BatchResult, String> {
    let mut records = load_journal_from_file(journal_file);
    let record_idx = match target_operation_id {
        Some(id) => records.iter().rposition(|r| {
            r.operation_id == id
                && (r.status == "completed" || r.status == "partially_completed")
        }),
        None => records
            .iter()
            .rposition(|r| r.status == "completed" || r.status == "partially_completed"),
    };

    let idx = record_idx.ok_or_else(|| "No eligible rename batch found to undo".to_string())?;
    let record = records[idx].clone();

    let active_final_keys: std::collections::HashSet<String> = record
        .successfully_completed_steps
        .iter()
        .map(|s| s.final_path.to_lowercase())
        .collect();

    struct UndoStage {
        file_id: String,
        current_final_path: PathBuf,
        temp_path: PathBuf,
        restore_orig_path: PathBuf,
    }

    let mut stages: Vec<UndoStage> = Vec::new();
    let mut results: Vec<RenameResultItem> = Vec::new();
    let mut failed_count = 0;

    // Preflight every step in reverse order
    for step in record.successfully_completed_steps.iter().rev() {
        let final_path = Path::new(&step.final_path);
        let orig_path = Path::new(&step.original_path);

        // 1. Check current renamed file exists and matches post-rename snapshot (T35)
        match read_current_snapshot(final_path) {
            Ok(curr_snap) => {
                if curr_snap.size_bytes != step.post_rename_snapshot.size_bytes
                    || (step.post_rename_snapshot.modified_at_ms > 0
                        && curr_snap.modified_at_ms != step.post_rename_snapshot.modified_at_ms)
                {
                    failed_count += 1;
                    results.push(RenameResultItem {
                        file_id: step.file_id.clone(),
                        from_path: step.final_path.clone(),
                        to_path: step.original_path.clone(),
                        outcome: RenameOutcome::Failed,
                        error_code: Some("FILE_MODIFIED_SINCE_RENAME".to_string()),
                        message: Some(
                            "Undo blocked: file was modified or replaced externally after rename"
                                .to_string(),
                        ),
                    });
                    continue;
                }
            }
            Err(e) => {
                failed_count += 1;
                results.push(RenameResultItem {
                    file_id: step.file_id.clone(),
                    from_path: step.final_path.clone(),
                    to_path: step.original_path.clone(),
                    outcome: RenameOutcome::Failed,
                    error_code: Some("SOURCE_MISSING".to_string()),
                    message: Some(e),
                });
                continue;
            }
        }

        // 2. Check original path is not occupied by an unrelated file (T34)
        let orig_lower = step.original_path.to_lowercase();
        let final_lower = step.final_path.to_lowercase();
        let is_case_only = orig_lower == final_lower;

        if !is_case_only && orig_path.exists() && !active_final_keys.contains(&orig_lower) {
            failed_count += 1;
            results.push(RenameResultItem {
                file_id: step.file_id.clone(),
                from_path: step.final_path.clone(),
                to_path: step.original_path.clone(),
                outcome: RenameOutcome::Failed,
                error_code: Some("ORIGINAL_PATH_OCCUPIED".to_string()),
                message: Some(
                    "Undo blocked: original filename is now occupied by another file on disk"
                        .to_string(),
                ),
            });
            continue;
        }

        let parent = final_path
            .parent()
            .ok_or_else(|| "Invalid parent folder".to_string())?;
        let temp_name = format!(".sbfr_undo_tmp_{}", Uuid::new_v4().simple());
        stages.push(UndoStage {
            file_id: step.file_id.clone(),
            current_final_path: final_path.to_path_buf(),
            temp_path: parent.join(temp_name),
            restore_orig_path: orig_path.to_path_buf(),
        });
    }

    // If any preflight check failed, block conflicting items safely without overwriting
    if failed_count > 0 && stages.is_empty() {
        return Ok(BatchResult {
            operation_id: record.operation_id,
            timestamp: Utc::now().to_rfc3339(),
            results,
            renamed_count: 0,
            unchanged_count: 0,
            skipped_count: 0,
            failed_count,
            can_undo: false,
            summary_message: format!(
                "Undo blocked for {} file(s) to prevent overwriting modified or existing files.",
                failed_count
            ),
        });
    }

    // Stage 1: Move eligible files to temporary names
    let mut staged_indices = Vec::new();
    for (i, st) in stages.iter().enumerate() {
        if let Err(e) = fs::rename(&st.current_final_path, &st.temp_path) {
            for &done_i in staged_indices.iter().rev() {
                let _ = fs::rename(&stages[done_i].temp_path, &stages[done_i].current_final_path);
            }
            return Err(format!("Undo staging failed: {}", e));
        }
        staged_indices.push(i);
    }

    // Stage 2: Move temporary files back to original paths
    let mut restored_count = 0;
    for st in &stages {
        if st.restore_orig_path.exists() {
            failed_count += 1;
            let _ = fs::rename(&st.temp_path, &st.current_final_path);
            results.push(RenameResultItem {
                file_id: st.file_id.clone(),
                from_path: st.current_final_path.to_string_lossy().to_string(),
                to_path: st.restore_orig_path.to_string_lossy().to_string(),
                outcome: RenameOutcome::Failed,
                error_code: Some("DESTINATION_OCCUPIED".to_string()),
                message: Some("Refused to overwrite existing file during undo".to_string()),
            });
            continue;
        }

        match fs::rename(&st.temp_path, &st.restore_orig_path) {
            Ok(_) => {
                restored_count += 1;
                results.push(RenameResultItem {
                    file_id: st.file_id.clone(),
                    from_path: st.current_final_path.to_string_lossy().to_string(),
                    to_path: st.restore_orig_path.to_string_lossy().to_string(),
                    outcome: RenameOutcome::Renamed,
                    error_code: None,
                    message: None,
                });
            }
            Err(e) => {
                failed_count += 1;
                let _ = fs::rename(&st.temp_path, &st.current_final_path);
                results.push(RenameResultItem {
                    file_id: st.file_id.clone(),
                    from_path: st.current_final_path.to_string_lossy().to_string(),
                    to_path: st.restore_orig_path.to_string_lossy().to_string(),
                    outcome: RenameOutcome::Failed,
                    error_code: Some("IO_ERROR".to_string()),
                    message: Some(e.to_string()),
                });
            }
        }
    }

    if failed_count == 0 {
        records[idx].status = "undone".to_string();
        save_journal_to_file(journal_file, &records)?;
    }

    Ok(BatchResult {
        operation_id: record.operation_id,
        timestamp: Utc::now().to_rfc3339(),
        results,
        renamed_count: restored_count,
        unchanged_count: 0,
        skipped_count: 0,
        failed_count,
        can_undo: false,
        summary_message: format!(
            "Undo completed: {} restored, {} failed.",
            restored_count, failed_count
        ),
    })
}
