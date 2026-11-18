pub mod commands;
pub mod formatter;
pub mod journal;
pub mod models;
pub mod parser;
pub mod renamer;
pub mod scanner;
pub mod validator;

use commands::{
    execute_rename_plan_v2, get_journal_history_v2, parse_preview_v2,
    recover_incomplete_batches_v2, scan_folder_v2, scan_paths_v2, undo_batch_v2,
    validate_rename_plan_v2,
};
use parser::{parse_filename, ParsedFilename};
use renamer::{
    execute_batch_rename, scan_directory, undo_batch_rename, validate_rename_plan,
    BatchRenameResult, FileScanItem, RenameBatchRecord, RenameRequestItem, ValidationIssue,
};
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use tauri::State;

pub struct AppState {
    pub undo_stack: Mutex<Vec<RenameBatchRecord>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            undo_stack: Mutex::new(Vec::new()),
        }
    }
}

#[tauri::command]
fn scan_folder(folder_path: String, include_all_files: bool) -> Result<Vec<FileScanItem>, String> {
    scan_directory(Path::new(&folder_path), include_all_files)
}

#[tauri::command]
fn parse_single_filename(filename: String) -> ParsedFilename {
    parse_filename(&filename)
}

#[tauri::command]
fn validate_batch(
    folder_path: String,
    requests: Vec<RenameRequestItem>,
) -> Result<Vec<ValidationIssue>, String> {
    validate_rename_plan(Path::new(&folder_path), &requests)
}

#[tauri::command]
fn rename_files_batch(
    folder_path: String,
    requests: Vec<RenameRequestItem>,
    state: State<'_, AppState>,
) -> Result<BatchRenameResult, String> {
    let result = execute_batch_rename(Path::new(&folder_path), &requests);
    if result.success {
        if let Some(ref batch) = result.batch {
            if let Ok(mut stack) = state.undo_stack.lock() {
                stack.push(batch.clone());
            }
        }
    }
    Ok(result)
}

#[tauri::command]
fn undo_last_batch(state: State<'_, AppState>) -> Result<BatchRenameResult, String> {
    let last_batch = {
        let mut stack = state
            .undo_stack
            .lock()
            .map_err(|_| "Failed to lock undo history".to_string())?;
        stack.pop()
    };

    match last_batch {
        Some(batch) => {
            let res = undo_batch_rename(&batch);
            if !res.success {
                if let Ok(mut stack) = state.undo_stack.lock() {
                    stack.push(batch);
                }
            }
            Ok(res)
        }
        None => Err("No rename batch in history to undo".to_string()),
    }
}

#[tauri::command]
fn get_undo_history(state: State<'_, AppState>) -> Result<Vec<RenameBatchRecord>, String> {
    let stack = state
        .undo_stack
        .lock()
        .map_err(|_| "Failed to lock undo history".to_string())?;
    Ok(stack.clone())
}

#[tauri::command]
fn create_sample_sandbox() -> Result<String, String> {
    let temp_base = std::env::temp_dir().join("SmartBulkFileRenamer_Sample");
    if temp_base.exists() {
        let _ = fs::remove_dir_all(&temp_base);
    }
    fs::create_dir_all(&temp_base)
        .map_err(|e| format!("Failed to create sample directory: {}", e))?;

    let sample_files = [
        "Trigger.S01E01.x265.720p.WEB-EDITH.mkv",
        "Trigger.S01E02.x265.720p.jshbsdkh-webrip.mkv",
        "Trigger.S01_E03.x265.720p.wefi-helman.mkv",
        "Trigger.S01.E10.x265.720p-WEB-randomvideo.mkv",
        "Severance_s1e01_2160p_ATVP_WEB-DL_DV_HDR_HEVC.mkv",
        "Trigger.1x03.HDTV.avi",
        "My.Show.S02E107.WEBRip.MKV",
        "Show.S01E01.S02E05.mkv",
        "filename_without_episode.mkv",
    ];

    for name in &sample_files {
        let file_path = temp_base.join(name);
        fs::write(&file_path, format!("Sample media placeholder for {}", name))
            .map_err(|e| format!("Failed writing sample file '{}': {}", name, e))?;
    }

    Ok(temp_base.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            scan_folder_v2,
            scan_paths_v2,
            parse_preview_v2,
            validate_rename_plan_v2,
            execute_rename_plan_v2,
            undo_batch_v2,
            get_journal_history_v2,
            recover_incomplete_batches_v2,
            parse_single_filename,
            validate_batch,
            rename_files_batch,
            undo_last_batch,
            get_undo_history,
            create_sample_sandbox
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
