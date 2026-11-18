use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileStatus {
    Ready,
    NeedsReview,
    Conflict,
    Skipped,
    Renamed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum MatchedSyntax {
    SxEy,
    NxM,
    #[serde(rename = "other")]
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParseConfidence {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIdentitySnapshot {
    pub size_bytes: u64,
    pub modified_at_ms: u64,
    pub is_read_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedEpisode {
    pub series: String,
    pub season: u32,
    pub episode: u32,
    pub season_digits: usize,
    pub episode_digits: usize,
    pub matched_syntax: MatchedSyntax,
    pub confidence: ParseConfidence,
    pub explanation: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub id: String,
    pub source_path: String,
    pub directory: String,
    pub original_name: String,
    pub stem: String,
    pub extension: String,
    pub size_bytes: u64,
    pub modified_at: u64,
    pub identity_snapshot: FileIdentitySnapshot,
    pub parsed: Option<ParsedEpisode>,
    pub proposed_name: Option<String>,
    pub selected: bool,
    pub status: FileStatus,
    pub issues: Vec<String>,
    pub manual_edited_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewOverrides {
    pub pattern: String,
    pub series_overrides: HashMap<String, String>,
    pub manual_row_names: HashMap<String, String>,
    pub excluded_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    pub entries: Vec<FileEntry>,
    pub plan_id: String,
    pub ready_count: usize,
    pub needs_review_count: usize,
    pub conflict_count: usize,
    pub skipped_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamePlanItem {
    pub file_id: String,
    pub source_path: String,
    pub destination_path: String,
    pub original_snapshot: FileIdentitySnapshot,
    pub included: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResult {
    pub plan_id: String,
    pub valid: bool,
    pub confirmation_token: Option<String>,
    pub entries: Vec<FileEntry>,
    pub blocking_errors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RenameOutcome {
    Renamed,
    Unchanged,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameResultItem {
    pub file_id: String,
    pub from_path: String,
    pub to_path: String,
    pub outcome: RenameOutcome,
    pub error_code: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub operation_id: String,
    pub timestamp: String,
    pub results: Vec<RenameResultItem>,
    pub renamed_count: usize,
    pub unchanged_count: usize,
    pub skipped_count: usize,
    pub failed_count: usize,
    pub can_undo: bool,
    pub summary_message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoStepRecord {
    pub file_id: String,
    pub original_path: String,
    pub temp_path: Option<String>,
    pub final_path: String,
    pub post_rename_snapshot: FileIdentitySnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoRecord {
    pub operation_id: String,
    pub timestamp: String,
    pub successfully_completed_steps: Vec<UndoStepRecord>,
    pub status: String,
}
