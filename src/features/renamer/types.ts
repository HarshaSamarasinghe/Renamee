// ============================================================================
// PHASE 1: DOMAIN DATA MODELS AND TYPED COMMAND CONTRACTS
// Matches Section 4 of Smart_Bulk_File_Renamer_Implementation_Plan.txt
// ============================================================================

export type FileStatus =
  | "ready"
  | "needs_review"
  | "conflict"
  | "skipped"
  | "renamed"
  | "failed";

export type MatchedSyntax = "SxEy" | "NxM" | "other";

export type ParseConfidence = "high" | "medium" | "low";

// Allows any preset or user-defined custom template string (e.g. "{series} - EP{episode:02}{extension}")
export type OutputPatternPreset = string;

export interface FileIdentitySnapshot {
  sizeBytes: number;
  modifiedAtMs: number;
  isReadOnly: boolean;
}

export interface ParsedEpisode {
  series: string;
  season: number;
  episode: number;
  seasonDigits: number;
  episodeDigits: number;
  matchedSyntax: MatchedSyntax;
  confidence: ParseConfidence;
  explanation: string;
}

export interface FileEntry {
  id: string;
  sourcePath: string;
  directory: string;
  originalName: string;
  stem: string;
  extension: string;
  sizeBytes: number;
  modifiedAt: number;
  identitySnapshot: FileIdentitySnapshot;
  parsed: ParsedEpisode | null;
  proposedName: string | null;
  selected: boolean;
  status: FileStatus;
  issues: string[];
  manualEditedName?: string;
}

export interface SeriesGroupOverride {
  groupKey: string;
  overrideSeriesTitle: string;
}

export interface PreviewOverrides {
  pattern: OutputPatternPreset;
  seriesOverrides: Record<string, string>;
  manualRowNames: Record<string, string>;
  excludedIds: string[];
}

export interface PreviewResult {
  entries: FileEntry[];
  planId: string;
  readyCount: number;
  needsReviewCount: number;
  conflictCount: number;
  skippedCount: number;
}

export interface RenamePlanItem {
  fileId: string;
  sourcePath: string;
  destinationPath: string;
  originalSnapshot: FileIdentitySnapshot;
  included: boolean;
}

export interface ValidationResult {
  planId: string;
  valid: boolean;
  confirmationToken: string | null;
  entries: FileEntry[];
  blockingErrors: string[];
}

export type RenameOutcome = "renamed" | "unchanged" | "skipped" | "failed";

export interface RenameResultItem {
  fileId: string;
  fromPath: string;
  toPath: string;
  outcome: RenameOutcome;
  errorCode?: string;
  message?: string;
}

export interface BatchResult {
  operationId: string;
  timestamp: string;
  results: RenameResultItem[];
  renamedCount: number;
  unchangedCount: number;
  skippedCount: number;
  failedCount: number;
  canUndo: boolean;
  summaryMessage: string;
}

export interface UndoStepRecord {
  fileId: string;
  originalPath: string;
  tempPath: string | null;
  finalPath: string;
  postRenameSnapshot: FileIdentitySnapshot;
}

export interface UndoRecord {
  operationId: string;
  timestamp: string;
  successfullyCompletedSteps: UndoStepRecord[];
  status: "completed" | "partially_completed" | "undone" | "incomplete_staged";
}
