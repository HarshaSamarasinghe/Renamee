import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  BatchRenameResult,
  evaluateBatchStatuses,
  FileScanItem,
  parseFilename,
  RenameBatchRecord,
  RenameRequestItem,
} from "./parser";

export function isTauriEnvironment(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

// Browser-mode virtual sandbox for testing when running in standard Vite browser tab
let browserSandboxFolder = "C:\\Users\\User\\Videos\\Trigger Season 1 (Sample)";
let browserVirtualDisk: { name: string; sizeBytes: number }[] = [
  { name: "Trigger.S01E01.x265.720p.WEB-EDITH.mkv", sizeBytes: 412_850_120 },
  { name: "Trigger.S01E02.x265.720p.WEB-EDITH.mkv", sizeBytes: 398_420_910 },
  { name: "Trigger.S01E03.x265.720p.WEB-EDITH.mkv", sizeBytes: 425_110_400 },
  { name: "Trigger.S01E04.x265.720p.WEB-EDITH.mkv", sizeBytes: 409_912_300 },
  {
    name: "Trigger.S01E06.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv",
    sizeBytes: 1_120_400_000,
  },
  {
    name: "Severance_s1e01_2160p_ATVP_WEB-DL_DV_HDR_HEVC.mkv",
    sizeBytes: 2_840_110_000,
  },
  {
    name: "Severance.1x02.Half.Loop.1080p.WEBRip.x265-RARBG.mp4",
    sizeBytes: 890_500_000,
  },
  {
    name: "The.Bear.Season.2.Episode.07.Forks.1080p.HULU.WEB-DL.mkv",
    sizeBytes: 950_200_000,
  },
  { name: "Mystery_Clip_Ep05_720p.mkv", sizeBytes: 185_000_000 },
  { name: "Behind_The_Scenes_Featurette.mp4", sizeBytes: 112_000_000 },
];
const browserUndoStack: RenameBatchRecord[] = [];

export async function pickFolderDialog(): Promise<string | null> {
  if (isTauriEnvironment()) {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select Folder Containing Video Files",
    });
    return typeof selected === "string" ? selected : null;
  }
  return browserSandboxFolder;
}

export async function createSampleSandboxFolder(): Promise<string> {
  if (isTauriEnvironment()) {
    return await invoke<string>("create_sample_sandbox");
  }
  browserVirtualDisk = [
    { name: "Trigger.S01E01.x265.720p.WEB-EDITH.mkv", sizeBytes: 412_850_120 },
    { name: "Trigger.S01E02.x265.720p.WEB-EDITH.mkv", sizeBytes: 398_420_910 },
    { name: "Trigger.S01E03.x265.720p.WEB-EDITH.mkv", sizeBytes: 425_110_400 },
    { name: "Trigger.S01E04.x265.720p.WEB-EDITH.mkv", sizeBytes: 409_912_300 },
    {
      name: "Trigger.S01E06.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv",
      sizeBytes: 1_120_400_000,
    },
    {
      name: "Severance_s1e01_2160p_ATVP_WEB-DL_DV_HDR_HEVC.mkv",
      sizeBytes: 2_840_110_000,
    },
    {
      name: "Severance.1x02.Half.Loop.1080p.WEBRip.x265-RARBG.mp4",
      sizeBytes: 890_500_000,
    },
    {
      name: "The.Bear.Season.2.Episode.07.Forks.1080p.HULU.WEB-DL.mkv",
      sizeBytes: 950_200_000,
    },
    { name: "Mystery_Clip_Ep05_720p.mkv", sizeBytes: 185_000_000 },
    { name: "Behind_The_Scenes_Featurette.mp4", sizeBytes: 112_000_000 },
  ];
  return browserSandboxFolder;
}

export async function scanFolderItems(
  folderPath: string,
  includeAllFiles: boolean
): Promise<FileScanItem[]> {
  if (isTauriEnvironment()) {
    return await invoke<FileScanItem[]>("scan_folder", {
      folderPath,
      includeAllFiles,
    });
  }

  const existingLower = new Set(
    browserVirtualDisk.map((f) => f.name.toLowerCase())
  );
  const rawItems: FileScanItem[] = browserVirtualDisk.map((file, idx) => ({
    id: `item-${idx}-${file.name}`,
    folderPath,
    originalName: file.name,
    fullPath: `${folderPath}\\${file.name}`,
    sizeBytes: file.sizeBytes,
    isVideo: true,
    parsed: parseFilename(file.name),
  }));

  return evaluateBatchStatuses(rawItems, existingLower);
}

export async function executeBatchRenameBridge(
  folderPath: string,
  requests: RenameRequestItem[]
): Promise<BatchRenameResult> {
  if (isTauriEnvironment()) {
    return await invoke<BatchRenameResult>("rename_files_batch", {
      folderPath,
      requests,
    });
  }

  const active = requests.filter((r) => r.originalName !== r.targetName);
  if (active.length === 0) {
    return {
      success: true,
      renamedCount: 0,
      batch: null,
      errors: [],
    };
  }

  // Perform safe validation on virtual disk
  const targetCounts = new Map<string, number>();
  const sourceLowerSet = new Set<string>();
  for (const r of active) {
    const tl = r.targetName.toLowerCase();
    targetCounts.set(tl, (targetCounts.get(tl) || 0) + 1);
    sourceLowerSet.add(r.originalName.toLowerCase());
  }

  const diskLower = new Set(
    browserVirtualDisk.map((f) => f.name.toLowerCase())
  );
  const errors: string[] = [];

  for (const r of active) {
    const tl = r.targetName.toLowerCase();
    const ol = r.originalName.toLowerCase();
    if ((targetCounts.get(tl) || 0) > 1) {
      errors.push(`Duplicate destination name '${r.targetName}'`);
    } else if (tl !== ol && diskLower.has(tl) && !sourceLowerSet.has(tl)) {
      errors.push(
        `Refusing to overwrite existing file '${r.targetName}' on disk`
      );
    }
  }

  if (errors.length > 0) {
    return {
      success: false,
      renamedCount: 0,
      batch: null,
      errors,
    };
  }

  const renameMap = new Map(active.map((r) => [r.originalName, r.targetName]));
  browserVirtualDisk = browserVirtualDisk.map((file) => {
    const newName = renameMap.get(file.name);
    return newName ? { ...file, name: newName } : file;
  });

  const batch: RenameBatchRecord = {
    batchId: `batch-${Date.now()}`,
    folderPath,
    timestamp: new Date().toISOString(),
    operations: active.map((r) => ({
      originalName: r.originalName,
      newName: r.targetName,
    })),
  };
  browserUndoStack.push(batch);

  return {
    success: true,
    renamedCount: active.length,
    batch,
    errors: [],
  };
}

export async function undoLastBatchBridge(): Promise<BatchRenameResult> {
  if (isTauriEnvironment()) {
    return await invoke<BatchRenameResult>("undo_last_batch");
  }

  const last = browserUndoStack.pop();
  if (!last) {
    throw new Error("No rename batch in history to undo");
  }

  const reverseMap = new Map(
    last.operations.map((op) => [op.newName, op.originalName])
  );
  browserVirtualDisk = browserVirtualDisk.map((file) => {
    const restored = reverseMap.get(file.name);
    return restored ? { ...file, name: restored } : file;
  });

  return {
    success: true,
    renamedCount: last.operations.length,
    batch: last,
    errors: [],
  };
}

export async function getUndoHistoryBridge(): Promise<RenameBatchRecord[]> {
  if (isTauriEnvironment()) {
    return await invoke<RenameBatchRecord[]>("get_undo_history");
  }
  return [...browserUndoStack];
}

export function loadDroppedFilenamesIntoSandbox(
  folderLabel: string,
  files: { name: string; sizeBytes: number }[]
): string {
  browserSandboxFolder = folderLabel;
  browserVirtualDisk = files;
  return browserSandboxFolder;
}
