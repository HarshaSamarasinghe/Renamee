# Smart Bulk File Renamer — MVP Release Checklist

- [x] **Offline Operation**: Zero network or shell execution permissions in `src-tauri/capabilities/default.json`.
- [x] **Primary Example Verified**: `Trigger.S01E01..E10` release filenames convert accurately to `Trigger S01E01..E10.mkv`.
- [x] **No Sort-Order Renumbering**: Missing episode numbers (`E01`, `E03`, `E10`) are never renumbered sequentially.
- [x] **Independent Series & Seasons**: Mixed series and seasons are grouped separately in the left rules panel.
- [x] **Needs Review Guard**: Ambiguous or unrecognized files are marked `Needs Review` and unchecked by default.
- [x] **Interactive Preview & Overrides**: Users can switch output format presets (`Space`, `Dot`, `Dash`), override series titles per season group, edit individual row names inline, or exclude rows before mutation.
- [x] **Authoritative Preflight Validation**: Duplicate destinations, existing disk conflicts, invalid Windows names, and stale file snapshots block unsafe execution.
- [x] **Collision-Safe Staged Renaming**: Two-phase staging via `.sbfr_tmp_<uuid>` supports case-only renames and swaps while preserving exact file contents.
- [x] **Persistent Journal & Undo**: Completed batches are recorded to `rename_journal.json` with post-rename identity snapshots for safe Undo and startup crash recovery.
- [x] **Automated Test Suites Passing**: Vitest frontend suite (`npm test`) and Rust `cargo test` suite verify parser, validation, staged rename, and undo flows.

## Packaging Commands on Windows
```powershell
# 1. Run Frontend Unit & Performance Tests
npm test

# 2. Verify Frontend Production Bundle
npm run build

# 3. Run Rust Unit & Tempfile Filesystem Integration Tests (requires Rust MSVC toolchain)
cd src-tauri
cargo test
cd ..

# 4. Build Windows Desktop Installer (NSIS / MSI)
npm run tauri build
```
