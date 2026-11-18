use crate::journal::{
    default_journal_path, execute_safe_undo, load_journal_from_file, recover_incomplete_journals,
};
use crate::models::{
    BatchResult, FileEntry, PreviewOverrides, PreviewResult, UndoRecord, ValidationResult,
};
use crate::renamer::execute_validated_plan_with_journal;
use crate::scanner::{
    build_preview_result, scan_arbitrary_paths_native, scan_folder_native, ScanFolderResponse,
};
use crate::validator::run_native_preflight;
use std::path::Path;

#[tauri::command]
pub fn scan_folder_v2(
    folder_path: String,
    recursive: bool,
    supported_extensions: Vec<String>,
) -> Result<ScanFolderResponse, String> {
    scan_folder_native(Path::new(&folder_path), recursive, &supported_extensions)
}

#[tauri::command]
pub fn scan_paths_v2(
    paths: Vec<String>,
    recursive: bool,
    supported_extensions: Vec<String>,
) -> Result<ScanFolderResponse, String> {
    scan_arbitrary_paths_native(&paths, recursive, &supported_extensions)
}

#[tauri::command]
pub fn parse_preview_v2(
    entries: Vec<FileEntry>,
    overrides: PreviewOverrides,
) -> Result<PreviewResult, String> {
    Ok(build_preview_result(entries, &overrides))
}

#[tauri::command]
pub fn validate_rename_plan_v2(entries: Vec<FileEntry>) -> Result<ValidationResult, String> {
    Ok(run_native_preflight(entries))
}

#[tauri::command]
pub fn execute_rename_plan_v2(
    entries: Vec<FileEntry>,
    confirmation_token: String,
) -> Result<BatchResult, String> {
    if !confirmation_token.starts_with("confirm_") {
        return Err("Missing or invalid confirmation token".to_string());
    }
    let journal_path = default_journal_path();
    Ok(execute_validated_plan_with_journal(entries, &journal_path))
}

#[tauri::command]
pub fn undo_batch_v2(operation_id: Option<String>) -> Result<BatchResult, String> {
    let journal_path = default_journal_path();
    execute_safe_undo(&journal_path, operation_id.as_deref())
}

#[tauri::command]
pub fn get_journal_history_v2() -> Result<Vec<UndoRecord>, String> {
    let journal_path = default_journal_path();
    Ok(load_journal_from_file(&journal_path))
}

#[tauri::command]
pub fn recover_incomplete_batches_v2() -> Result<usize, String> {
    let journal_path = default_journal_path();
    recover_incomplete_journals(&journal_path)
}
