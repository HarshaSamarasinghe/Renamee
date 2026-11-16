pub mod parser;
pub mod renamer;

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
        "Trigger.S01E02.x265.720p.WEB-EDITH.mkv",
        "Trigger.S01E03.x265.720p.WEB-EDITH.mkv",
        "Trigger.S01E04.x265.720p.WEB-EDITH.mkv",
        "Trigger.S01E06.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv",
        "Severance_s1e01_2160p_ATVP_WEB-DL_DV_HDR_HEVC.mkv",
        "Severance.1x02.Half.Loop.1080p.WEBRip.x265-RARBG.mp4",
        "The.Bear.Season.2.Episode.07.Forks.1080p.HULU.WEB-DL.mkv",
        "Mystery_Clip_Ep05_720p.mkv",
        "Behind_The_Scenes_Featurette.mp4",
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
