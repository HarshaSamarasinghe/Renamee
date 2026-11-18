# Smart Bulk File Renamer — Functional & Safety Requirements

## 1. Non-Negotiable Safety Invariants
- **No File Content Modification or Overwriting**: Renaming affects filenames only within their original directories. No existing file on disk is ever overwritten or deleted.
- **Exact Extension Preservation**: The final extension (including exact casing, e.g., `.mkv` vs `.MKV` vs `.MkV`) is always preserved.
- **No Sort-Order Renumbering**: Episode numbers are extracted strictly from each individual filename (`S01E01`, `S01_E03`, `S01.E10`, `1x03`). Missing episodes (e.g., `E01` followed by `E03`) remain `E01` and `E03`.
- **Needs Review Over Guessing**: Ambiguous filenames (missing season/episode token, multiple conflicting episode tokens like `Show.S01E01.S02E05.mkv`, unhandled `[Group]` prefixes, or 4-digit release years) are flagged as `Needs Review` (`needs_review`) and excluded from automatic execution.
- **Explicit Confirmation**: Previewing never mutates the filesystem. Renaming requires an explicit user confirmation modal and an authoritative Rust preflight `confirmation_token`.
- **100% Local & Offline**: No network permissions, external APIs, or online metadata lookups are used.

## 2. Functional Requirements Matrix (`FR-01` – `FR-24`)
| ID | Requirement | Implementation Module |
|---|---|---|
| `FR-01` | Folder selection via native dialog | `src/features/renamer/api.ts`, `FolderPicker.tsx` |
| `FR-02` | Multi-file selection & safe drag-and-drop | `src/features/renamer/api.ts`, `App.tsx` |
| `FR-03` | Default video extensions `.mkv`, `.mp4`, `.avi`, `.mov`, `.wmv`, `.m4v` (configurable) | `scanner.rs`, `RenameRulesPanel.tsx` |
| `FR-04` | Preserve file path and exact extension within original directory | `formatter.rs`, `validator.rs` |
| `FR-05` | Optional recursive folder scanning with explicit scope badge | `scanner.rs`, `FolderPicker.tsx` |
| `FR-06` | Recognize `S01E01`, `s1e1`, `S1.E1`, `S01_E03`, `S01.E10`, `1x03` with boundary checks | `parser.rs`, `format.ts` |
| `FR-07` | Support mixed seasons and series independently without merging | `format.ts`, `hooks.ts` |
| `FR-08` | Normalize `.` and `_` in series title to spaces while keeping meaningful punctuation | `formatter.rs`, `format.ts` |
| `FR-09` | Strip release metadata by taking title before episode token (never stripping title words like `"Web"`) | `parser.rs`, `format.ts` |
| `FR-10` | Generate preview names preserving original extension casing | `formatter.rs`, `format.ts` |
| `FR-11` | Group-level series title overrides & per-row manual edits (row edits take precedence) | `hooks.ts`, `RenameRulesPanel.tsx`, `FilePreviewTable.tsx` |
| `FR-12` | Output format presets (`Show S01E01.mkv`, `Show.S01E01.mkv`, `Show - S01E01.mkv`) | `formatter.rs`, `RenameRulesPanel.tsx` |
| `FR-13` | Search, filter, display-only sort, and select/deselect rows | `FilePreviewTable.tsx`, `api.ts` |
| `FR-14` | Display parse status and reasons (`Ready`, `Needs Review`, `Conflict`, `Excluded`) | `StatusBadge.tsx`, `FilePreviewTable.tsx` |
| `FR-15` | Detect duplicate target names within batch using Windows case-insensitive keys | `validator.rs`, `validation.ts` |
| `FR-16` | Detect conflicts with existing untouched files in the directory | `validator.rs`, `validation.ts` |
| `FR-17` | Reject invalid Windows characters, reserved DOS device names (`CON`, `NUL`, etc.), trailing dots/spaces, and >255 char names | `validator.rs`, `validation.ts` |
| `FR-18` | Reject path traversal (`..`) and path separators (`/` or `\`) in proposed basenames | `validator.rs`, `validation.ts` |
| `FR-19` | Require final confirmation dialog before any mutation | `RenameConfirmationDialog.tsx` |
| `FR-20` | Two-phase staged rename (`source -> .sbfr_tmp_<uuid> -> destination`) without overwriting | `renamer.rs` |
| `FR-21` | Persistent journal undo with post-rename snapshot & collision verification | `journal.rs` |
| `FR-22` | Execution result summary dialog with counts, errors, and copyable report | `BatchResultDialog.tsx` |
| `FR-23` | Zero network permissions required | `src-tauri/capabilities/default.json` |
| `FR-24` | Disable Rename button when 0 files are ready or any blocking conflict exists | `App.tsx` |
