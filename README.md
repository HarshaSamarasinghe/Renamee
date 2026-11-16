# Smart Bulk File Renamer

A Windows 11-inspired desktop application built with **Tauri 2**, **React**, **TypeScript**, **Rust**, **Tailwind CSS**, and **shadcn/ui** that automatically recognizes TV series, season, and episode patterns in video filenames and safely batch-renames them offline.

## Example Transformation

Given a folder containing:
- `Trigger.S01E01.x265.720p.WEB-EDITH.mkv`
- `Trigger.S01E02.x265.720p.WEB-EDITH.mkv`
- `Trigger.S01E03.x265.720p.WEB-EDITH.mkv`
- `Trigger.S01E04.x265.720p.WEB-EDITH.mkv`

The recognition engine automatically extracts:
- **Series Name**: `Trigger`
- **Season**: `01`
- **Episode**: `01`, `02`, `03`, `04`
- **Extension**: `.mkv`
- **Stripped Metadata**: `x265`, `720p`, `WEB-EDITH`

And produces:
- `Trigger S01E01.mkv`
- `Trigger S01E02.mkv`
- `Trigger S01E03.mkv`
- `Trigger S01E04.mkv`

---

## Architecture & Major Design Decisions

1. **Separated Recognition & Filesystem Modules**:
   - **Recognition Engine** (`src-tauri/src/parser.rs` & `src/lib/parser.ts`): Pure, deterministic regular-expression and token-analysis pipeline. Supports `S01E01`, `s1e1`, `S01E01-E02`, `1x01`, and `Season 1 Episode 2` formats across dot, underscore, hyphen, and space separators.
   - **Zero-Guessing Policy**: Never invents episode numbers from file sort order. Files with episode-only numbers (`Ep05`) or ambiguous 4-digit years/resolutions without season markers are flagged as `Ambiguous` or `Unrecognized` and unchecked by default.
   - **Safe Two-Phase Atomic Renamer** (`src-tauri/src/renamer.rs`):
     - **Phase 1**: Stages all participating files to temporary `.sbfr_tmp_<uuid>_<orig>` names in the target folder. This enables **Windows NTFS case-only renames** (`trigger s01e01.mkv` -> `Trigger S01E01.mkv`) and prevents cyclic batch collisions.
     - **Phase 2**: Moves each staged file to its final destination after verifying the destination does not exist. If any error occurs, all completed operations in the batch are automatically rolled back.
   - **Full Undo Stack**: Every executed batch is pushed to an in-memory undo stack in Rust (`AppState`) so users can revert the entire batch in one click.

---

## Running & Packaging on Windows

### 1. Install Dependencies
```powershell
npm install
```

### 2. Run Automated Tests (TypeScript & Rust)
```powershell
# Run Vitest unit tests (filename recognition, conflicts, case-only renames)
npm test

# Run Cargo unit & tempfile integration tests (safe batch rename, rollback, undo)
cd src-tauri
cargo test
```

### 3. Run in Development Mode
```powershell
npm run tauri dev
```
*(Tip: Click **"Load Sample Folder"** in the top bar to generate a temporary sandbox folder pre-populated with `Trigger.S01E01.x265.720p.WEB-EDITH.mkv` through `S01E04` and edge-case test files before running on real media folders.)*

### 4. Build Windows Desktop Executable (`.exe` / `.msi`)
```powershell
npm run tauri build
```
The compiled Windows installer and standalone executable will be output to:
`src-tauri/target/release/bundle/`
