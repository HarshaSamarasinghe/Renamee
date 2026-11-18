// ============================================================================
// PHASE 2..6: FOLDER SCAN, PREVIEW, VALIDATION, REAL DISK RENAME & UNDO API
// Supports:
//  1. Tauri 2 Native Desktop Backend (Rust)
//  2. Browser Native File System Access API (window.showDirectoryPicker readwrite)
//  3. Vite Node.js Local Disk Backend (/__local_fs/*)
//  4. In-Memory Fallback for Unit Tests (Vitest)
// ============================================================================

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  analyzeFilename,
  applyPreviewOverrides,
  DEFAULT_PATTERN,
  splitStemAndExtension,
} from "./format";
import {
  BatchResult,
  FileEntry,
  PreviewOverrides,
  PreviewResult,
  RenameResultItem,
  UndoRecord,
  ValidationResult,
} from "./types";
import { validatePreviewBatch } from "./validation";

export const DEFAULT_SUPPORTED_EXTENSIONS = [
  ".mkv",
  ".mp4",
  ".avi",
  ".mov",
  ".wmv",
  ".m4v",
];

export interface ScanFolderResponse {
  entries: FileEntry[];
  scanErrors: string[];
  scannedFolder: string;
  recursive: boolean;
}

export function isTauriEnvironment(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

function isBrowserDevServer(): boolean {
  return (
    typeof window !== "undefined" &&
    !isTauriEnvironment() &&
    (window.location.protocol === "http:" ||
      window.location.protocol === "https:")
  );
}

// ============================================================================
// BROWSER FILE SYSTEM ACCESS API (Real Disk Read/Write via DirectoryHandle)
// ============================================================================
interface BrowserHandleEntry {
  name: string;
  directory: string;
  sizeBytes: number;
  modifiedAt: number;
  fileHandle: any; // FileSystemFileHandle
  dirHandle: any;  // FileSystemDirectoryHandle
}

let activeDirectoryHandle: any = null;
let activeDirectoryLabel = "";
let browserHandleEntries: BrowserHandleEntry[] = [];

async function scanDirectoryHandleEntries(
  dirHandle: any,
  dirLabel: string,
  recursive: boolean,
  supportedExtensions: string[],
  out: BrowserHandleEntry[]
) {
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === "file") {
      if (hasSupportedExtension(name, supportedExtensions)) {
        const file: File = await handle.getFile();
        out.push({
          name: file.name,
          directory: dirLabel,
          sizeBytes: file.size,
          modifiedAt: file.lastModified || Date.now(),
          fileHandle: handle,
          dirHandle,
        });
      }
    } else if (handle.kind === "directory" && recursive) {
      await scanDirectoryHandleEntries(
        handle,
        `${dirLabel}\\${name}`,
        true,
        supportedExtensions,
        out
      );
    }
  }
}

async function doesFileExistInDirHandle(
  dirHandle: any,
  filename: string
): Promise<boolean> {
  try {
    await dirHandle.getFileHandle(filename, { create: false });
    return true;
  } catch {
    return false;
  }
}

async function renameFileInDirHandle(
  dirHandle: any,
  fileHandle: any,
  oldName: string,
  newName: string
): Promise<any> {
  // 1. Chromium 111+ native in-place move() on FileSystemFileHandle
  if (typeof fileHandle.move === "function") {
    await fileHandle.move(newName);
    return await dirHandle.getFileHandle(newName, { create: false });
  }

  // 2. Fallback: stream copy to new file handle + remove old entry
  const srcFile: File = await fileHandle.getFile();
  const newFileHandle = await dirHandle.getFileHandle(newName, {
    create: true,
  });
  const writable = await newFileHandle.createWritable();
  await writable.write(await srcFile.arrayBuffer());
  await writable.close();
  await dirHandle.removeEntry(oldName);
  return newFileHandle;
}

// ============================================================================
// IN-MEMORY FALLBACK SANDBOX (Used by Vitest & fallback `<input>` picker)
// ============================================================================
const DEFAULT_SAMPLE_FOLDER = "C:\\Users\\User\\Videos\\Trigger_Sample_Sandbox";
const INITIAL_SAMPLE_FILES = [
  {
    name: "Trigger.S01E01.x265.720p.WEB-EDITH.mkv",
    directory: DEFAULT_SAMPLE_FOLDER,
    sizeBytes: 412_850_120,
    modifiedAt: 1731900001000,
  },
  {
    name: "Trigger.S01E02.x265.720p.jshbsdkh-webrip.mkv",
    directory: DEFAULT_SAMPLE_FOLDER,
    sizeBytes: 398_420_910,
    modifiedAt: 1731900002000,
  },
  {
    name: "Trigger.S01_E03.x265.720p.wefi-helman.mkv",
    directory: DEFAULT_SAMPLE_FOLDER,
    sizeBytes: 425_110_400,
    modifiedAt: 1731900003000,
  },
  {
    name: "Trigger.S01.E10.x265.720p-WEB-randomvideo.mkv",
    directory: DEFAULT_SAMPLE_FOLDER,
    sizeBytes: 409_912_300,
    modifiedAt: 1731900004000,
  },
  {
    name: "Trigger.1x03.HDTV.avi",
    directory: `${DEFAULT_SAMPLE_FOLDER}\\Subfolder_Archive`,
    sizeBytes: 245_000_000,
    modifiedAt: 1731900005000,
  },
  {
    name: "My.Show.S02E107.WEBRip.MKV",
    directory: DEFAULT_SAMPLE_FOLDER,
    sizeBytes: 890_500_000,
    modifiedAt: 1731900006000,
  },
  {
    name: "Show.S01E01.S02E05.mkv",
    directory: DEFAULT_SAMPLE_FOLDER,
    sizeBytes: 512_000_000,
    modifiedAt: 1731900007000,
  },
  {
    name: "filename_without_episode.mkv",
    directory: DEFAULT_SAMPLE_FOLDER,
    sizeBytes: 112_000_000,
    modifiedAt: 1731900008000,
  },
];

let virtualSampleFolder = DEFAULT_SAMPLE_FOLDER;
let virtualSampleFiles = INITIAL_SAMPLE_FILES.map((f) => ({ ...f }));
const virtualJournal: UndoRecord[] = [];
const handleUndoStack: {
  operationId: string;
  timestamp: string;
  steps: {
    fileId: string;
    dirHandle: any;
    currentHandle: any;
    originalName: string;
    finalName: string;
    directory: string;
  }[];
}[] = [];

export function resetBrowserSampleSandbox(): string {
  activeDirectoryHandle = null;
  activeDirectoryLabel = "";
  browserHandleEntries = [];
  virtualSampleFolder = DEFAULT_SAMPLE_FOLDER;
  virtualSampleFiles = INITIAL_SAMPLE_FILES.map((f) => ({ ...f }));
  return virtualSampleFolder;
}

export function ingestBrowserFileList(fileList: FileList | File[]): string {
  activeDirectoryHandle = null;
  browserHandleEntries = [];
  const files = Array.from(fileList);
  if (files.length === 0) return virtualSampleFolder;

  const firstRel = (files[0] as File & { webkitRelativePath?: string })
    .webkitRelativePath;
  const rootName =
    firstRel && firstRel.includes("/")
      ? `SelectedFolder\\${firstRel.split("/")[0]}`
      : "SelectedFiles";

  virtualSampleFolder = rootName;
  virtualSampleFiles = files.map((f) => {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
    let dir = rootName;
    if (rel && rel.includes("/")) {
      const parts = rel.split("/");
      parts.pop();
      if (parts.length > 1) {
        dir = `${rootName}\\${parts.slice(1).join("\\")}`;
      }
    }
    return {
      name: f.name,
      directory: dir,
      sizeBytes: f.size,
      modifiedAt: f.lastModified || Date.now(),
    };
  });

  return virtualSampleFolder;
}

export function hasSupportedExtension(
  filename: string,
  supportedExtensions: string[] = DEFAULT_SUPPORTED_EXTENSIONS
): boolean {
  if (supportedExtensions.includes("*") || supportedExtensions.includes(".*")) {
    return true;
  }
  const { extension } = splitStemAndExtension(filename);
  if (!extension) return false;
  const lower = extension.toLowerCase();
  return supportedExtensions.some((ext) => {
    const normalized = ext.startsWith(".")
      ? ext.toLowerCase()
      : `.${ext.toLowerCase()}`;
    return normalized === lower;
  });
}

export function buildFileEntryFromRaw(raw: {
  id?: string;
  name: string;
  directory: string;
  sizeBytes: number;
  modifiedAt: number;
}): FileEntry {
  const analysis = analyzeFilename(raw.name, DEFAULT_PATTERN);
  const needsReview = analysis.needsReview || !analysis.parsed;
  const isUnchanged = !needsReview && analysis.proposedName === raw.name;

  return {
    id: raw.id ?? `entry-${raw.directory}-${raw.name}`,
    sourcePath: `${raw.directory}\\${raw.name}`,
    directory: raw.directory,
    originalName: raw.name,
    stem: analysis.stem,
    extension: analysis.extension,
    sizeBytes: raw.sizeBytes,
    modifiedAt: raw.modifiedAt,
    identitySnapshot: {
      sizeBytes: raw.sizeBytes,
      modifiedAtMs: raw.modifiedAt,
      isReadOnly: false,
    },
    parsed: analysis.parsed,
    proposedName: analysis.proposedName,
    selected: !needsReview && !isUnchanged,
    status: needsReview
      ? "needs_review"
      : isUnchanged
        ? "skipped"
        : "ready",
    issues: analysis.issues,
  };
}

/**
 * FR-01: Folder Picker Dialog
 * Uses Tauri dialog in desktop mode, or File System Access API (showDirectoryPicker with readwrite) in browser mode.
 */
export async function chooseFolderNativeDialog(): Promise<string | null> {
  if (isTauriEnvironment()) {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select Folder Containing Video Files",
    });
    return typeof selected === "string" ? selected : null;
  }

  // Modern Chromium (Edge / Chrome) File System Access API with direct disk read/write permission!
  if (typeof window !== "undefined" && "showDirectoryPicker" in window) {
    try {
      const dirHandle = await (window as any).showDirectoryPicker({
        mode: "readwrite",
      });
      activeDirectoryHandle = dirHandle;
      activeDirectoryLabel = dirHandle.name;
      return activeDirectoryLabel;
    } catch (err: any) {
      // User cancelled the dialog
      if (err && err.name === "AbortError") {
        return null;
      }
    }
  }

  // Fallback for browsers without showDirectoryPicker
  if (typeof document !== "undefined") {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.setAttribute("webkitdirectory", "true");
      input.multiple = true;
      input.onchange = () => {
        if (input.files && input.files.length > 0) {
          resolve(ingestBrowserFileList(input.files));
        } else {
          resolve(null);
        }
      };
      input.click();
    });
  }

  return virtualSampleFolder;
}

/**
 * FR-02: Multi-File Selection Dialog
 */
export async function chooseFilesNativeDialog(
  supportedExtensions: string[] = DEFAULT_SUPPORTED_EXTENSIONS
): Promise<string[] | null> {
  if (isTauriEnvironment()) {
    const cleanExts = supportedExtensions.map((e) => e.replace(/^\./, ""));
    const selected = await open({
      directory: false,
      multiple: true,
      title: "Select Video Files to Rename",
      filters: [{ name: "Video Files", extensions: cleanExts }],
    });
    if (!selected) return null;
    return Array.isArray(selected) ? selected : [selected];
  }

  if (typeof document !== "undefined") {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.accept = supportedExtensions.join(",");
      input.onchange = () => {
        if (input.files && input.files.length > 0) {
          const folder = ingestBrowserFileList(input.files);
          resolve(virtualSampleFiles.map((f) => `${folder}\\${f.name}`));
        } else {
          resolve(null);
        }
      };
      input.click();
    });
  }

  return virtualSampleFiles
    .filter((f) => f.directory === virtualSampleFolder)
    .map((f) => `${f.directory}\\${f.name}`);
}

export async function createRealSampleFolderCommand(): Promise<string> {
  activeDirectoryHandle = null;
  browserHandleEntries = [];

  if (isTauriEnvironment()) {
    return await invoke<string>("create_sample_sandbox");
  }
  if (isBrowserDevServer()) {
    try {
      const res = await fetch("/__local_fs/sample-sandbox", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        if (data.folderPath) return data.folderPath;
      }
    } catch {
      // Fallback to in-memory
    }
  }
  return resetBrowserSampleSandbox();
}

/**
 * Phase 2 Command: scan_folder
 */
export async function scanFolderCommand(
  folderPath: string,
  recursive = false,
  supportedExtensions: string[] = DEFAULT_SUPPORTED_EXTENSIONS
): Promise<ScanFolderResponse> {
  if (isTauriEnvironment()) {
    return await invoke<ScanFolderResponse>("scan_folder_v2", {
      folderPath,
      recursive,
      supportedExtensions,
    });
  }

  // 1. If user picked a real folder via window.showDirectoryPicker, scan its live FileSystemDirectoryHandle
  if (activeDirectoryHandle && folderPath === activeDirectoryLabel) {
    const collected: BrowserHandleEntry[] = [];
    await scanDirectoryHandleEntries(
      activeDirectoryHandle,
      activeDirectoryLabel,
      recursive,
      supportedExtensions,
      collected
    );
    collected.sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    );
    browserHandleEntries = collected;

    const entries = collected.map((f, idx) =>
      buildFileEntryFromRaw({
        id: `fs-handle-${idx}-${f.name}`,
        name: f.name,
        directory: f.directory,
        sizeBytes: f.sizeBytes,
        modifiedAt: f.modifiedAt,
      })
    );

    return {
      entries,
      scanErrors: [],
      scannedFolder: activeDirectoryLabel,
      recursive,
    };
  }

  // 2. If user typed/pasted an absolute Windows path (e.g. D:\Videos\Show) or loaded the disk sample sandbox
  const looksLikeRealWindowsPath = /^[a-zA-Z]:[\\/]/.test(folderPath);
  if (isBrowserDevServer() && looksLikeRealWindowsPath) {
    try {
      const res = await fetch("/__local_fs/scan-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folderPath,
          recursive,
          supportedExtensions,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const entries: FileEntry[] = (data.files || []).map(
          (f: any, idx: number) =>
            buildFileEntryFromRaw({
              id: `disk-${idx}-${f.name}`,
              name: f.name,
              directory: f.directory,
              sizeBytes: f.sizeBytes,
              modifiedAt: f.modifiedAt,
            })
        );
        return {
          entries,
          scanErrors: data.scanErrors || [],
          scannedFolder: data.scannedFolder || folderPath,
          recursive: Boolean(data.recursive),
        };
      }
    } catch {
      // Fallback to in-memory virtual files below
    }
  }

  // 3. In-memory virtual files (used by Vitest and `<input>` fallback)
  const filtered = virtualSampleFiles.filter((file) => {
    const inRoot = file.directory === folderPath;
    const inSub = file.directory.startsWith(`${folderPath}\\`);
    if (!recursive && !inRoot) return false;
    if (recursive && !inRoot && !inSub) return false;
    return hasSupportedExtension(file.name, supportedExtensions);
  });

  const entries = filtered
    .slice()
    .sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    )
    .map((f, idx) =>
      buildFileEntryFromRaw({
        id: `entry-${idx}-${f.name}`,
        ...f,
      })
    );

  return {
    entries,
    scanErrors: [],
    scannedFolder: folderPath,
    recursive,
  };
}

/**
 * Phase 2 Command: scan_paths
 */
export async function scanPathsCommand(
  paths: string[],
  recursive = false,
  supportedExtensions: string[] = DEFAULT_SUPPORTED_EXTENSIONS
): Promise<ScanFolderResponse> {
  if (isTauriEnvironment()) {
    return await invoke<ScanFolderResponse>("scan_paths_v2", {
      paths,
      recursive,
      supportedExtensions,
    });
  }
  return scanFolderCommand(virtualSampleFolder, recursive, supportedExtensions);
}

/**
 * Phase 2 Command: parse_preview
 */
export async function parsePreviewCommand(
  entries: FileEntry[],
  overrides: PreviewOverrides
): Promise<PreviewResult> {
  if (isTauriEnvironment()) {
    return await invoke<PreviewResult>("parse_preview_v2", {
      entries,
      overrides,
    });
  }

  const updated = applyPreviewOverrides(entries, overrides);
  let readyCount = 0;
  let needsReviewCount = 0;
  let conflictCount = 0;
  let skippedCount = 0;

  for (const e of updated) {
    if (e.status === "ready") readyCount++;
    else if (e.status === "needs_review") needsReviewCount++;
    else if (e.status === "conflict") conflictCount++;
    else if (e.status === "skipped") skippedCount++;
  }

  return {
    entries: updated,
    planId: `plan-${Date.now()}`,
    readyCount,
    needsReviewCount,
    conflictCount,
    skippedCount,
  };
}

export type SortField = "originalName" | "proposedName" | "status" | "episode";
export type SortDirection = "asc" | "desc";

export function sortEntriesForDisplay(
  entries: FileEntry[],
  field: SortField,
  direction: SortDirection
): FileEntry[] {
  const copy = [...entries];
  const dirMultiplier = direction === "asc" ? 1 : -1;

  copy.sort((a, b) => {
    switch (field) {
      case "proposedName": {
        const pa = (a.proposedName ?? a.originalName).toLowerCase();
        const pb = (b.proposedName ?? b.originalName).toLowerCase();
        return pa.localeCompare(pb) * dirMultiplier;
      }
      case "status":
        return a.status.localeCompare(b.status) * dirMultiplier;
      case "episode": {
        const ea = a.parsed
          ? a.parsed.season * 10000 + a.parsed.episode
          : 999999;
        const eb = b.parsed
          ? b.parsed.season * 10000 + b.parsed.episode
          : 999999;
        return (ea - eb) * dirMultiplier;
      }
      case "originalName":
      default:
        return (
          a.originalName
            .toLowerCase()
            .localeCompare(b.originalName.toLowerCase()) * dirMultiplier
        );
    }
  });

  return copy;
}

/**
 * Phase 4 Command: validate_rename_plan
 */
export async function validateRenamePlanCommand(
  entries: FileEntry[]
): Promise<ValidationResult> {
  if (isTauriEnvironment()) {
    return await invoke<ValidationResult>("validate_rename_plan_v2", {
      entries,
    });
  }

  const validated = validatePreviewBatch(entries);
  const blockingErrors: string[] = [];
  let readyCount = 0;

  for (const e of validated) {
    if (e.status === "conflict") {
      blockingErrors.push(`${e.originalName}: ${e.issues.join("; ")}`);
    } else if (e.status === "ready" && e.selected) {
      readyCount++;
    }
  }

  const planId = `plan-${Date.now()}`;
  const valid = blockingErrors.length === 0 && readyCount > 0;
  return {
    planId,
    valid,
    confirmationToken: valid ? `confirm_${planId}_token` : null,
    entries: validated,
    blockingErrors,
  };
}

/**
 * Phase 5 Command: execute_rename_plan
 * Performs real disk renaming via:
 *  - Tauri Rust backend (when in Tauri desktop app)
 *  - Browser FileSystemDirectoryHandle.move() (when folder selected via Choose Folder in Chrome/Edge)
 *  - Vite Node.js local fs backend (when folder loaded via Windows path / Sample Sandbox)
 */
export async function executeRenamePlanCommand(
  entries: FileEntry[],
  confirmationToken: string
): Promise<BatchResult> {
  if (!confirmationToken.startsWith("confirm_")) {
    throw new Error("Missing or invalid confirmation token");
  }

  if (isTauriEnvironment()) {
    return await invoke<BatchResult>("execute_rename_plan_v2", {
      entries,
      confirmationToken,
    });
  }

  const preflight = await validateRenamePlanCommand(entries);
  const operationId = `op-${Date.now()}`;
  const timestamp = new Date().toISOString();

  if (!preflight.valid) {
    return {
      operationId,
      timestamp,
      results: [],
      renamedCount: 0,
      unchangedCount: 0,
      skippedCount: 0,
      failedCount: preflight.blockingErrors.length,
      canUndo: false,
      summaryMessage: `Preflight failed: ${preflight.blockingErrors.join("; ")}`,
    };
  }

  // 1. Real disk rename via Browser File System Access API (activeDirectoryHandle)
  if (activeDirectoryHandle && browserHandleEntries.length > 0) {
    const results: RenameResultItem[] = [];
    const undoSteps: (typeof handleUndoStack)[number]["steps"] = [];
    let renamedCount = 0;
    let unchangedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const entry of preflight.entries) {
      if (!entry.selected || entry.status !== "ready" || !entry.proposedName) {
        if (entry.proposedName === entry.originalName) {
          unchangedCount++;
        } else {
          skippedCount++;
        }
        continue;
      }

      const handleItem = browserHandleEntries.find(
        (h) =>
          h.directory === entry.directory && h.name === entry.originalName
      );
      if (!handleItem) {
        failedCount++;
        results.push({
          fileId: entry.id,
          fromPath: entry.sourcePath,
          toPath: `${entry.directory}\\${entry.proposedName}`,
          outcome: "failed",
          message: "Could not locate file handle in selected folder",
        });
        continue;
      }

      try {
        const isCaseOnly =
          entry.originalName.toLowerCase() ===
          entry.proposedName.toLowerCase();
        if (!isCaseOnly) {
          const exists = await doesFileExistInDirHandle(
            handleItem.dirHandle,
            entry.proposedName
          );
          if (exists) {
            failedCount++;
            results.push({
              fileId: entry.id,
              fromPath: entry.sourcePath,
              toPath: `${entry.directory}\\${entry.proposedName}`,
              outcome: "failed",
              message: `Target file '${entry.proposedName}' already exists on disk`,
            });
            continue;
          }
        }

        const newHandle = await renameFileInDirHandle(
          handleItem.dirHandle,
          handleItem.fileHandle,
          entry.originalName,
          entry.proposedName
        );

        handleItem.name = entry.proposedName;
        handleItem.fileHandle = newHandle;

        undoSteps.push({
          fileId: entry.id,
          dirHandle: handleItem.dirHandle,
          currentHandle: newHandle,
          originalName: entry.originalName,
          finalName: entry.proposedName,
          directory: entry.directory,
        });

        renamedCount++;
        results.push({
          fileId: entry.id,
          fromPath: entry.sourcePath,
          toPath: `${entry.directory}\\${entry.proposedName}`,
          outcome: "renamed",
        });
      } catch (err: any) {
        failedCount++;
        results.push({
          fileId: entry.id,
          fromPath: entry.sourcePath,
          toPath: `${entry.directory}\\${entry.proposedName}`,
          outcome: "failed",
          message: err?.message || String(err),
        });
      }
    }

    if (undoSteps.length > 0) {
      handleUndoStack.push({
        operationId,
        timestamp,
        steps: undoSteps,
      });
    }

    return {
      operationId,
      timestamp,
      results,
      renamedCount,
      unchangedCount,
      skippedCount,
      failedCount,
      canUndo: renamedCount > 0,
      summaryMessage: `Successfully renamed ${renamedCount} file(s) on your hard drive.`,
    };
  }

  // 2. Real disk rename via Vite Node.js backend (when loaded via Windows folder path / Sample Folder)
  const firstDir = preflight.entries[0]?.directory || "";
  if (isBrowserDevServer() && /^[a-zA-Z]:[\\/]/.test(firstDir)) {
    try {
      const res = await fetch("/__local_fs/execute-rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entries: preflight.entries.map((e) => ({
            fileId: e.id,
            sourcePath: e.sourcePath,
            directory: e.directory,
            originalName: e.originalName,
            proposedName: e.proposedName,
            selected: e.selected,
            status: e.status,
          })),
        }),
      });
      if (res.ok) {
        return (await res.json()) as BatchResult;
      }
    } catch {
      // Fallback below
    }
  }

  // 3. In-memory fallback (Vitest)
  const results: RenameResultItem[] = [];
  const completedSteps: UndoRecord["successfullyCompletedSteps"] = [];
  let renamedCount = 0;
  let unchangedCount = 0;
  let skippedCount = 0;

  for (const entry of preflight.entries) {
    if (!entry.selected || entry.status !== "ready" || !entry.proposedName) {
      if (entry.proposedName === entry.originalName) {
        unchangedCount++;
      } else {
        skippedCount++;
      }
      continue;
    }

    const toPath = `${entry.directory}\\${entry.proposedName}`;
    results.push({
      fileId: entry.id,
      fromPath: entry.sourcePath,
      toPath,
      outcome: "renamed",
    });

    completedSteps.push({
      fileId: entry.id,
      originalPath: entry.sourcePath,
      tempPath: null,
      finalPath: toPath,
      postRenameSnapshot: entry.identitySnapshot,
    });

    const vf = virtualSampleFiles.find(
      (f) => f.directory === entry.directory && f.name === entry.originalName
    );
    if (vf) {
      vf.name = entry.proposedName;
    }

    renamedCount++;
  }

  if (completedSteps.length > 0) {
    virtualJournal.push({
      operationId,
      timestamp,
      successfullyCompletedSteps: completedSteps,
      status: "completed",
    });
  }

  return {
    operationId,
    timestamp,
    results,
    renamedCount,
    unchangedCount,
    skippedCount,
    failedCount: 0,
    canUndo: renamedCount > 0,
    summaryMessage: `Successfully renamed ${renamedCount} file(s).`,
  };
}

/**
 * Phase 6 Command: undo_batch
 */
export async function undoBatchCommand(
  operationId?: string
): Promise<BatchResult> {
  if (isTauriEnvironment()) {
    return await invoke<BatchResult>("undo_batch_v2", {
      operationId: operationId ?? null,
    });
  }

  // 1. Undo via Browser File System Access API if handleUndoStack has entries
  if (handleUndoStack.length > 0) {
    const batch = handleUndoStack.pop()!;
    const results: RenameResultItem[] = [];
    let restored = 0;
    let failed = 0;

    for (const step of [...batch.steps].reverse()) {
      try {
        const newHandle = await renameFileInDirHandle(
          step.dirHandle,
          step.currentHandle,
          step.finalName,
          step.originalName
        );
        const item = browserHandleEntries.find(
          (h) => h.directory === step.directory && h.name === step.finalName
        );
        if (item) {
          item.name = step.originalName;
          item.fileHandle = newHandle;
        }
        restored++;
        results.push({
          fileId: step.fileId,
          fromPath: `${step.directory}\\${step.finalName}`,
          toPath: `${step.directory}\\${step.originalName}`,
          outcome: "renamed",
        });
      } catch (err: any) {
        failed++;
        results.push({
          fileId: step.fileId,
          fromPath: `${step.directory}\\${step.finalName}`,
          toPath: `${step.directory}\\${step.originalName}`,
          outcome: "failed",
          message: err?.message || String(err),
        });
      }
    }

    return {
      operationId: batch.operationId,
      timestamp: new Date().toISOString(),
      results,
      renamedCount: restored,
      unchangedCount: 0,
      skippedCount: 0,
      failedCount: failed,
      canUndo: false,
      summaryMessage: `Restored ${restored} file(s) to their original names on disk.`,
    };
  }

  // 2. Undo via Vite Node.js local disk backend
  if (isBrowserDevServer() && virtualJournal.length === 0) {
    try {
      const res = await fetch("/__local_fs/undo-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operationId }),
      });
      if (res.ok) {
        return (await res.json()) as BatchResult;
      }
    } catch {
      // Fallback below
    }
  }

  // 3. In-memory fallback (Vitest)
  let idx = -1;
  if (operationId) {
    idx = virtualJournal.findIndex(
      (r) => r.operationId === operationId && r.status === "completed"
    );
  } else {
    for (let i = virtualJournal.length - 1; i >= 0; i--) {
      if (virtualJournal[i].status === "completed") {
        idx = i;
        break;
      }
    }
  }

  if (idx < 0) {
    throw new Error("No eligible rename batch found to undo");
  }

  const record = virtualJournal[idx];
  const results: RenameResultItem[] = [];
  let restored = 0;

  for (const step of [...record.successfullyCompletedSteps].reverse()) {
    const origName = step.originalPath.split("\\").pop()!;
    const finalName = step.finalPath.split("\\").pop()!;
    const vf = virtualSampleFiles.find((f) => f.name === finalName);
    if (vf) {
      vf.name = origName;
    }
    restored++;
    results.push({
      fileId: step.fileId,
      fromPath: step.finalPath,
      toPath: step.originalPath,
      outcome: "renamed",
    });
  }

  record.status = "undone";

  return {
    operationId: record.operationId,
    timestamp: new Date().toISOString(),
    results,
    renamedCount: restored,
    unchangedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    canUndo: false,
    summaryMessage: `Restored ${restored} file(s) to their original names.`,
  };
}

export async function recoverIncompleteBatchesCommand(): Promise<number> {
  if (isTauriEnvironment()) {
    return await invoke<number>("recover_incomplete_batches_v2");
  }
  return 0;
}
