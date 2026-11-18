import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";
import os from "os";
import { execFile } from "child_process";

const host = process.env.TAURI_DEV_HOST;

interface UndoStep {
  fileId: string;
  originalPath: string;
  finalPath: string;
  sizeBytes: number;
}

interface UndoBatch {
  operationId: string;
  timestamp: string;
  steps: UndoStep[];
  status: "completed" | "undone";
}

const journalFilePath = path.join(
  os.tmpdir(),
  "SmartBulkFileRenamer_AppData",
  "node_rename_journal.json"
);

function readJournal(): UndoBatch[] {
  try {
    if (fs.existsSync(journalFilePath)) {
      return JSON.parse(fs.readFileSync(journalFilePath, "utf-8"));
    }
  } catch {
    // ignore corrupt journal
  }
  return [];
}

function writeJournal(batches: UndoBatch[]) {
  fs.mkdirSync(path.dirname(journalFilePath), { recursive: true });
  fs.writeFileSync(journalFilePath, JSON.stringify(batches, null, 2), "utf-8");
}

function readJsonBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: any) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: any, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

function collectFilesOnDisk(
  dirPath: string,
  recursive: boolean,
  allowedExts: string[],
  outFiles: {
    name: string;
    directory: string;
    sourcePath: string;
    sizeBytes: number;
    modifiedAt: number;
    isReadOnly: boolean;
  }[],
  errors: string[]
) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err: any) {
    errors.push(`Cannot read folder '${dirPath}': ${err.message}`);
    return;
  }

  const subdirs: string[] = [];
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (recursive) subdirs.push(full);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (
        allowedExts.length === 0 ||
        allowedExts.includes("*") ||
        allowedExts.includes(ext)
      ) {
        files.push(full);
      }
    }
  }

  files.sort((a, b) =>
    path.basename(a).toLowerCase().localeCompare(path.basename(b).toLowerCase())
  );
  subdirs.sort();

  for (const filePath of files) {
    try {
      const stat = fs.statSync(filePath);
      outFiles.push({
        name: path.basename(filePath),
        directory: path.dirname(filePath),
        sourcePath: filePath,
        sizeBytes: stat.size,
        modifiedAt: Math.floor(stat.mtimeMs),
        isReadOnly: (stat.mode & 0o200) === 0,
      });
    } catch (err: any) {
      errors.push(`Cannot stat '${filePath}': ${err.message}`);
    }
  }

  if (recursive) {
    for (const sub of subdirs) {
      collectFilesOnDisk(sub, true, allowedExts, outFiles, errors);
    }
  }
}

function localFilesystemPlugin(): Plugin {
  return {
    name: "vite-local-filesystem-renamer",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/__local_fs/")) {
          return next();
        }

        try {
          // 1. Native Windows Folder Picker via PowerShell
          if (req.url === "/__local_fs/pick-folder" && req.method === "POST") {
            const psScript = `
              Add-Type -AssemblyName System.Windows.Forms
              $dummy = New-Object System.Windows.Forms.Form -Property @{TopMost = $true}
              $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
              $dialog.Description = 'Select Folder Containing Video Files'
              $dialog.ShowNewFolderButton = $false
              if ($dialog.ShowDialog($dummy) -eq [System.Windows.Forms.DialogResult]::OK) {
                Write-Output $dialog.SelectedPath
              }
            `;
            execFile(
              "powershell.exe",
              ["-NoProfile", "-Sta", "-Command", psScript],
              (err, stdout) => {
                if (err) {
                  return sendJson(res, 200, { folderPath: null });
                }
                const picked = stdout.trim();
                return sendJson(res, 200, { folderPath: picked || null });
              }
            );
            return;
          }

          // 2. Native Windows Multi-File Picker via PowerShell
          if (req.url === "/__local_fs/pick-files" && req.method === "POST") {
            const psScript = `
              Add-Type -AssemblyName System.Windows.Forms
              $dummy = New-Object System.Windows.Forms.Form -Property @{TopMost = $true}
              $dialog = New-Object System.Windows.Forms.OpenFileDialog
              $dialog.Title = 'Select Video Files to Rename'
              $dialog.Multiselect = $true
              $dialog.Filter = 'Video Files (*.mkv;*.mp4;*.avi;*.mov;*.wmv;*.m4v)|*.mkv;*.mp4;*.avi;*.mov;*.wmv;*.m4v|All Files (*.*)|*.*'
              if ($dialog.ShowDialog($dummy) -eq [System.Windows.Forms.DialogResult]::OK) {
                $dialog.FileNames | ForEach-Object { Write-Output $_ }
              }
            `;
            execFile(
              "powershell.exe",
              ["-NoProfile", "-Sta", "-Command", psScript],
              (err, stdout) => {
                if (err) {
                  return sendJson(res, 200, { paths: [] });
                }
                const lines = stdout
                  .split(/\r?\n/)
                  .map((s) => s.trim())
                  .filter(Boolean);
                return sendJson(res, 200, { paths: lines });
              }
            );
            return;
          }

          // 3. Create Real Sample Sandbox Folder on Disk
          if (
            req.url === "/__local_fs/sample-sandbox" &&
            req.method === "POST"
          ) {
            const sampleDir = path.join(
              os.tmpdir(),
              "SmartBulkFileRenamer_Sample"
            );
            if (fs.existsSync(sampleDir)) {
              fs.rmSync(sampleDir, { recursive: true, force: true });
            }
            fs.mkdirSync(sampleDir, { recursive: true });

            const sampleFiles = [
              "Trigger.S01E01.x265.720p.WEB-EDITH.mkv",
              "Trigger.S01E02.x265.720p.jshbsdkh-webrip.mkv",
              "Trigger.S01_E03.x265.720p.wefi-helman.mkv",
              "Trigger.S01.E10.x265.720p-WEB-randomvideo.mkv",
              "Trigger.1x03.HDTV.avi",
              "My.Show.S02E107.WEBRip.MKV",
              "Show.S01E01.S02E05.mkv",
              "filename_without_episode.mkv",
            ];
            for (const name of sampleFiles) {
              fs.writeFileSync(
                path.join(sampleDir, name),
                `Sample media file content for ${name}`,
                "utf-8"
              );
            }
            return sendJson(res, 200, { folderPath: sampleDir });
          }

          // 4. Scan Real Folder on Disk
          if (req.url === "/__local_fs/scan-folder" && req.method === "POST") {
            const body = await readJsonBody(req);
            const folderPath = String(body.folderPath || "").trim();
            const recursive = Boolean(body.recursive);
            const supportedExtensions: string[] = Array.isArray(
              body.supportedExtensions
            )
              ? body.supportedExtensions.map((e: string) =>
                  e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`
                )
              : [".mkv", ".mp4", ".avi", ".mov", ".wmv", ".m4v"];

            if (!folderPath || !fs.existsSync(folderPath)) {
              return sendJson(res, 400, {
                error: `Folder does not exist on disk: ${folderPath}`,
              });
            }

            const files: any[] = [];
            const scanErrors: string[] = [];
            collectFilesOnDisk(
              folderPath,
              recursive,
              supportedExtensions,
              files,
              scanErrors
            );

            return sendJson(res, 200, {
              files,
              scanErrors,
              scannedFolder: folderPath,
              recursive,
            });
          }

          // 5. Scan Specific File Paths on Disk
          if (req.url === "/__local_fs/scan-paths" && req.method === "POST") {
            const body = await readJsonBody(req);
            const pathsList: string[] = Array.isArray(body.paths)
              ? body.paths
              : [];
            const files: any[] = [];
            const scanErrors: string[] = [];

            for (const p of pathsList) {
              try {
                if (fs.existsSync(p) && fs.statSync(p).isFile()) {
                  const stat = fs.statSync(p);
                  files.push({
                    name: path.basename(p),
                    directory: path.dirname(p),
                    sourcePath: p,
                    sizeBytes: stat.size,
                    modifiedAt: Math.floor(stat.mtimeMs),
                    isReadOnly: false,
                  });
                }
              } catch (err: any) {
                scanErrors.push(`Failed reading '${p}': ${err.message}`);
              }
            }

            const scannedFolder =
              files.length > 0 ? files[0].directory : "";
            return sendJson(res, 200, {
              files,
              scanErrors,
              scannedFolder,
              recursive: false,
            });
          }

          // 6. Execute Real Staged Rename on Disk
          if (
            req.url === "/__local_fs/execute-rename" &&
            req.method === "POST"
          ) {
            const body = await readJsonBody(req);
            const items: {
              fileId: string;
              sourcePath: string;
              directory: string;
              originalName: string;
              proposedName: string;
              selected: boolean;
              status: string;
            }[] = Array.isArray(body.entries) ? body.entries : [];

            const operationId = `op-${Date.now()}`;
            const timestamp = new Date().toISOString();
            const results: any[] = [];
            let unchangedCount = 0;
            let skippedCount = 0;

            const readyItems = items.filter((item) => {
              if (!item.selected || item.status !== "ready" || !item.proposedName) {
                if (item.proposedName === item.originalName) {
                  unchangedCount++;
                  results.push({
                    fileId: item.fileId,
                    fromPath: item.sourcePath,
                    toPath: item.sourcePath,
                    outcome: "unchanged",
                  });
                } else {
                  skippedCount++;
                }
                return false;
              }
              return true;
            });

            // Stage 1: Rename source -> temporary file in same folder
            const staged: {
              fileId: string;
              sourcePath: string;
              tempPath: string;
              finalPath: string;
              originalName: string;
              proposedName: string;
            }[] = [];

            const activeSourceLower = new Set(
              readyItems.map((r) => r.sourcePath.toLowerCase())
            );

            // Preflight check on disk
            for (const item of readyItems) {
              if (!fs.existsSync(item.sourcePath)) {
                return sendJson(res, 200, {
                  operationId,
                  timestamp,
                  results: [
                    {
                      fileId: item.fileId,
                      fromPath: item.sourcePath,
                      toPath: path.join(item.directory, item.proposedName),
                      outcome: "failed",
                      message: `Source file not found on disk: ${item.sourcePath}`,
                    },
                  ],
                  renamedCount: 0,
                  unchangedCount,
                  skippedCount,
                  failedCount: 1,
                  canUndo: false,
                  summaryMessage: `Aborted: source file '${item.originalName}' was not found on disk.`,
                });
              }

              const finalPath = path.join(item.directory, item.proposedName);
              const isCaseOnlySelf =
                item.sourcePath.toLowerCase() === finalPath.toLowerCase();

              if (
                !isCaseOnlySelf &&
                fs.existsSync(finalPath) &&
                !activeSourceLower.has(finalPath.toLowerCase())
              ) {
                return sendJson(res, 200, {
                  operationId,
                  timestamp,
                  results: [
                    {
                      fileId: item.fileId,
                      fromPath: item.sourcePath,
                      toPath: finalPath,
                      outcome: "failed",
                      message: `Target file '${item.proposedName}' already exists on disk`,
                    },
                  ],
                  renamedCount: 0,
                  unchangedCount,
                  skippedCount,
                  failedCount: 1,
                  canUndo: false,
                  summaryMessage: `Blocked to prevent overwriting existing file '${item.proposedName}'.`,
                });
              }

              const tempPath = path.join(
                item.directory,
                `.sbfr_tmp_${Date.now()}_${Math.random()
                  .toString(36)
                  .slice(2)}_${item.originalName}`
              );

              staged.push({
                fileId: item.fileId,
                sourcePath: item.sourcePath,
                tempPath,
                finalPath,
                originalName: item.originalName,
                proposedName: item.proposedName,
              });
            }

            // Execute Stage 1: source -> temp
            const stage1Done: typeof staged = [];
            for (const st of staged) {
              try {
                fs.renameSync(st.sourcePath, st.tempPath);
                stage1Done.push(st);
              } catch (err: any) {
                for (const done of stage1Done.reverse()) {
                  try {
                    fs.renameSync(done.tempPath, done.sourcePath);
                  } catch {}
                }
                return sendJson(res, 200, {
                  operationId,
                  timestamp,
                  results: [
                    {
                      fileId: st.fileId,
                      fromPath: st.sourcePath,
                      toPath: st.finalPath,
                      outcome: "failed",
                      message: err.message,
                    },
                  ],
                  renamedCount: 0,
                  unchangedCount,
                  skippedCount,
                  failedCount: 1,
                  canUndo: false,
                  summaryMessage: `Failed renaming '${st.originalName}': ${err.message}. All changes rolled back.`,
                });
              }
            }

            // Execute Stage 2: temp -> final
            const completedUndoSteps: UndoStep[] = [];
            for (const st of staged) {
              try {
                fs.renameSync(st.tempPath, st.finalPath);
                const stat = fs.statSync(st.finalPath);
                completedUndoSteps.push({
                  fileId: st.fileId,
                  originalPath: st.sourcePath,
                  finalPath: st.finalPath,
                  sizeBytes: stat.size,
                });
                results.push({
                  fileId: st.fileId,
                  fromPath: st.sourcePath,
                  toPath: st.finalPath,
                  outcome: "renamed",
                });
              } catch (err: any) {
                try {
                  fs.renameSync(st.tempPath, st.sourcePath);
                } catch {}
                results.push({
                  fileId: st.fileId,
                  fromPath: st.sourcePath,
                  toPath: st.finalPath,
                  outcome: "failed",
                  message: err.message,
                });
              }
            }

            if (completedUndoSteps.length > 0) {
              const journal = readJournal();
              journal.push({
                operationId,
                timestamp,
                steps: completedUndoSteps,
                status: "completed",
              });
              writeJournal(journal);
            }

            const renamedCount = completedUndoSteps.length;
            const failedCount = staged.length - renamedCount;

            return sendJson(res, 200, {
              operationId,
              timestamp,
              results,
              renamedCount,
              unchangedCount,
              skippedCount,
              failedCount,
              canUndo: renamedCount > 0,
              summaryMessage: `Successfully renamed ${renamedCount} file(s) on disk.`,
            });
          }

          // 7. Undo Last Batch on Disk
          if (req.url === "/__local_fs/undo-batch" && req.method === "POST") {
            const journal = readJournal();
            let targetIdx = -1;
            for (let i = journal.length - 1; i >= 0; i--) {
              if (journal[i].status === "completed") {
                targetIdx = i;
                break;
              }
            }

            if (targetIdx === -1) {
              return sendJson(res, 400, {
                error: "No completed rename batch found to undo.",
              });
            }

            const batch = journal[targetIdx];
            const results: any[] = [];
            let restored = 0;
            let failed = 0;

            // Two-phase undo on disk
            const stagedUndo: {
              fileId: string;
              finalPath: string;
              tempPath: string;
              originalPath: string;
            }[] = [];

            for (const step of [...batch.steps].reverse()) {
              if (!fs.existsSync(step.finalPath)) {
                failed++;
                results.push({
                  fileId: step.fileId,
                  fromPath: step.finalPath,
                  toPath: step.originalPath,
                  outcome: "failed",
                  message: "Renamed file no longer exists on disk",
                });
                continue;
              }
              const tempPath = path.join(
                path.dirname(step.finalPath),
                `.sbfr_undo_${Date.now()}_${Math.random()
                  .toString(36)
                  .slice(2)}`
              );
              fs.renameSync(step.finalPath, tempPath);
              stagedUndo.push({
                fileId: step.fileId,
                finalPath: step.finalPath,
                tempPath,
                originalPath: step.originalPath,
              });
            }

            for (const st of stagedUndo) {
              if (fs.existsSync(st.originalPath)) {
                fs.renameSync(st.tempPath, st.finalPath);
                failed++;
                results.push({
                  fileId: st.fileId,
                  fromPath: st.finalPath,
                  toPath: st.originalPath,
                  outcome: "failed",
                  message:
                    "Original filename is now occupied by another file on disk",
                });
                continue;
              }
              fs.renameSync(st.tempPath, st.originalPath);
              restored++;
              results.push({
                fileId: st.fileId,
                fromPath: st.finalPath,
                toPath: st.originalPath,
                outcome: "renamed",
              });
            }

            if (failed === 0) {
              journal[targetIdx].status = "undone";
              writeJournal(journal);
            }

            return sendJson(res, 200, {
              operationId: batch.operationId,
              timestamp: new Date().toISOString(),
              results,
              renamedCount: restored,
              unchangedCount: 0,
              skippedCount: 0,
              failedCount: failed,
              canUndo: false,
              summaryMessage: `Restored ${restored} file(s) to their original filenames on disk.`,
            });
          }

          return next();
        } catch (err: any) {
          return sendJson(res, 500, { error: err.message || String(err) });
        }
      });
    },
  };
}

export default defineConfig(async () => ({
  plugins: [react(), localFilesystemPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    open: !process.env.TAURI_ENV_PLATFORM,
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Changed output file names to avoid cache issues when deploying to production
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name].[ext]",
      },
    },
  },
}));
