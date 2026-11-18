import React, { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Wand2,
  XCircle,
} from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FolderPicker } from "@/components/FolderPicker";
import { FileDropzone } from "@/components/FileDropzone";
import { RenameRulesPanel } from "@/components/RenameRulesPanel";
import { FilePreviewTable } from "@/components/FilePreviewTable";
import { RenameConfirmationDialog } from "@/components/RenameConfirmationDialog";
import { BatchResultDialog } from "@/components/BatchResultDialog";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  createRealSampleFolderCommand,
  executeRenamePlanCommand,
  ingestBrowserFileList,
  isTauriEnvironment,
  recoverIncompleteBatchesCommand,
  SortField,
  undoBatchCommand,
  validateRenamePlanCommand,
} from "@/features/renamer/api";
import { useRenamerSession } from "@/features/renamer/hooks";
import { BatchResult } from "@/features/renamer/types";
import { cn } from "@/lib/utils";

export function App() {
  const [darkMode, setDarkMode] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const executingLockRef = useRef(false);
  const [lastBatchResult, setLastBatchResult] = useState<BatchResult | null>(
    null
  );
  const [resultModalOpen, setResultModalOpen] = useState(false);
  const [undoCount, setUndoCount] = useState(0);
  const [banner, setBanner] = useState<{
    type: "success" | "error" | "info";
    text: string;
  } | null>(null);

  const session = useRenamerSession();

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }, [darkMode]);

  // Phase 6 (T32): Check for any interrupted staged operations on startup and recover safely
  useEffect(() => {
    recoverIncompleteBatchesCommand()
      .then((recoveredCount) => {
        if (recoveredCount > 0) {
          setBanner({
            type: "info",
            text: `Recovered ${recoveredCount} staged file(s) from an interrupted previous session.`,
          });
        }
      })
      .catch(() => {});
  }, []);

  // Native Tauri drag-drop listener
  useEffect(() => {
    if (!isTauriEnvironment()) return;
    let unlisten: (() => void) | undefined;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over") {
          setIsDragging(true);
        } else if (event.payload.type === "drop") {
          setIsDragging(false);
          const paths = event.payload.paths;
          if (paths && paths.length > 0) {
            const firstPath = paths[0];
            const lastSep = Math.max(
              firstPath.lastIndexOf("\\"),
              firstPath.lastIndexOf("/")
            );
            const hasExt = /\.[a-z0-9]{2,5}$/i.test(firstPath);
            const dirPath =
              hasExt && lastSep > 0 ? firstPath.slice(0, lastSep) : firstPath;
            session.scanFolder(dirPath);
          }
        } else {
          setIsDragging(false);
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      if (unlisten) unlisten();
    };
  }, [session]);

  const handleLoadSampleSandbox = async () => {
    try {
      const sampleDir = await createRealSampleFolderCommand();
      await session.scanFolder(sampleDir, session.recursive);
      setBanner({
        type: "info",
        text: `Loaded sample folder on disk: ${sampleDir}`,
      });
    } catch (err) {
      setBanner({
        type: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleSortChange = (field: SortField) => {
    if (session.sortField === field) {
      session.setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      session.setSortField(field);
      session.setSortDirection("asc");
    }
  };

  const handleToggleSelectAll = (includeAll: boolean) => {
    for (const entry of session.previewEntries) {
      if (entry.proposedName) {
        session.toggleRowInclusion(entry.id, includeAll);
      }
    }
  };

  const readyEntries = session.previewEntries.filter(
    (e) => e.status === "ready" && e.selected && e.proposedName
  );

  // FR-24: Disable Rename when all files are excluded or when blocking conflicts remain
  const canClickRename =
    readyEntries.length > 0 &&
    session.counts.conflicts === 0 &&
    !isExecuting;

  const handleExecuteConfirmedRename = async () => {
    if (!canClickRename || executingLockRef.current) return;
    executingLockRef.current = true;
    setIsExecuting(true);
    try {
      // Phase 4: Authoritative preflight validation generates a confirmation token
      const preflight = await validateRenamePlanCommand(session.previewEntries);
      if (!preflight.valid || !preflight.confirmationToken) {
        setConfirmOpen(false);
        setBanner({
          type: "error",
          text: `Preflight validation blocked execution: ${preflight.blockingErrors.join(
            " | "
          )}`,
        });
        return;
      }

      // Phase 5: Execute validated plan with confirmation token
      const batchResult = await executeRenamePlanCommand(
        preflight.entries,
        preflight.confirmationToken
      );

      if (batchResult.canUndo) {
        setUndoCount((c) => c + 1);
      }

      setConfirmOpen(false);
      setLastBatchResult(batchResult);
      setResultModalOpen(true);

      if (batchResult.renamedCount > 0 && session.scannedFolder) {
        await session.scanFolder(session.scannedFolder, session.recursive);
      }
    } catch (err) {
      setBanner({
        type: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      executingLockRef.current = false;
      setIsExecuting(false);
    }
  };

  const handleUndoLastBatch = async () => {
    try {
      const res = await undoBatchCommand();
      if (res.renamedCount > 0) {
        setUndoCount((c) => Math.max(0, c - 1));
        setBanner({
          type: "info",
          text: res.summaryMessage,
        });
        if (session.scannedFolder) {
          await session.scanFolder(session.scannedFolder, session.recursive);
        }
      } else {
        setBanner({
          type: "error",
          text: res.summaryMessage,
        });
      }
    } catch (err) {
      setBanner({
        type: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div
      className="flex h-screen w-screen flex-col bg-background text-foreground select-none overflow-hidden"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setIsDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        if (!isTauriEnvironment() && e.dataTransfer.files.length > 0) {
          const folder = ingestBrowserFileList(e.dataTransfer.files);
          session.scanFolder(folder, session.recursive);
        }
      }}
    >
      {isDragging && (
        <FileDropzone
          isDragging
          onChooseFolder={session.pickAndScanFolder}
          onAddFiles={session.pickAndScanFiles}
          onLoadSampleSandbox={handleLoadSampleSandbox}
        />
      )}

      {/* Top Application Title Bar */}
      <header className="flex items-center justify-between border-b border-border/80 bg-card/80 px-6 py-3 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 text-primary border border-primary/25 shadow-xs">
            <Wand2 className="h-4 w-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-semibold tracking-tight">
                Smart Bulk File Renamer
              </h1>
              <Badge variant="default" className="text-[10px] py-0 px-1.5">
                LOCAL OFFLINE
              </Badge>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Deterministic TV episode parser & collision-safe Windows batch renamer
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <ThemeToggle
            darkMode={darkMode}
            onToggle={() => setDarkMode((d) => !d)}
          />
        </div>
      </header>

      {/* Top Folder & Scope Toolbar */}
      <FolderPicker
        scannedFolder={session.scannedFolder}
        recursive={session.recursive}
        isScanning={session.isScanning}
        canUndo={undoCount > 0}
        undoCount={undoCount}
        onChooseFolder={session.pickAndScanFolder}
        onScanTypedFolder={(p) => session.scanFolder(p, session.recursive)}
        onAddFiles={session.pickAndScanFiles}
        onLoadSampleSandbox={handleLoadSampleSandbox}
        onToggleRecursive={(rec) => {
          session.setRecursive(rec);
          if (session.scannedFolder) {
            session.scanFolder(session.scannedFolder, rec);
          }
        }}
        onRescan={() =>
          session.scanFolder(session.scannedFolder, session.recursive)
        }
        onUndoLastBatch={handleUndoLastBatch}
      />

      {/* Notification Banner */}
      {(banner || session.scanErrors.length > 0) && (
        <div className="px-6 pt-2">
          {banner && (
            <div
              className={cn(
                "flex items-center justify-between rounded-lg border px-3.5 py-2 text-xs",
                banner.type === "success" &&
                  "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
                banner.type === "error" &&
                  "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300",
                banner.type === "info" &&
                  "border-primary/30 bg-primary/10 text-primary"
              )}
            >
              <div className="flex items-center gap-2">
                {banner.type === "success" && (
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                )}
                {banner.type === "error" && (
                  <XCircle className="h-4 w-4 shrink-0" />
                )}
                {banner.type === "info" && (
                  <Info className="h-4 w-4 shrink-0" />
                )}
                <span>{banner.text}</span>
              </div>
              <button
                type="button"
                onClick={() => setBanner(null)}
                className="text-xs underline opacity-75 hover:opacity-100"
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}

      {/* Main Split Workspace: Left Rules Panel + Right Preview Table */}
      {session.baseEntries.length === 0 ? (
        <FileDropzone
          onChooseFolder={session.pickAndScanFolder}
          onAddFiles={session.pickAndScanFiles}
          onLoadSampleSandbox={handleLoadSampleSandbox}
        />
      ) : (
        <div className="flex flex-1 overflow-hidden">
          <RenameRulesPanel
            pattern={session.pattern}
            onChangePattern={session.setPattern}
            seriesGroups={session.seriesGroups}
            onChangeGroupSeries={session.setGroupSeriesTitle}
            supportedExtensions={session.supportedExtensions}
            onChangeSupportedExtensions={session.setSupportedExtensions}
          />

          <div className="flex flex-1 flex-col overflow-hidden">
            <FilePreviewTable
              entries={session.displayEntries}
              counts={session.counts}
              statusFilter={session.statusFilter}
              onChangeStatusFilter={session.setStatusFilter}
              searchQuery={session.searchQuery}
              onChangeSearchQuery={session.setSearchQuery}
              sortField={session.sortField}
              sortDirection={session.sortDirection}
              onChangeSort={handleSortChange}
              onToggleRowInclusion={session.toggleRowInclusion}
              onToggleSelectAll={handleToggleSelectAll}
              onCommitRowManualName={session.setRowManualName}
            />

            {/* Footer Summary & Prominent Rename Button (Section 2 & FR-24) */}
            <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-border/80 bg-card/85 px-6 py-3 text-xs backdrop-blur-md">
              <div className="flex flex-wrap items-center gap-4">
                <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                  {session.counts.ready} ready
                </span>
                <span>•</span>
                <span className="text-amber-600 dark:text-amber-400">
                  {session.counts.needsReview} need review
                </span>
                <span>•</span>
                <span
                  className={cn(
                    session.counts.conflicts > 0
                      ? "font-semibold text-rose-600 dark:text-rose-400"
                      : "text-muted-foreground"
                  )}
                >
                  {session.counts.conflicts} conflicts
                </span>
                <span>•</span>
                <span className="text-muted-foreground">
                  {session.counts.skipped} excluded
                </span>

                {session.counts.conflicts > 0 && (
                  <span className="inline-flex items-center gap-1 rounded bg-rose-500/10 px-2 py-0.5 text-[11px] text-rose-600 dark:text-rose-400">
                    <AlertTriangle className="h-3 w-3" />
                    Resolve or exclude conflicting rows before renaming
                  </span>
                )}
              </div>

              <Button
                size="lg"
                disabled={!canClickRename}
                onClick={() => setConfirmOpen(true)}
                className="px-7 shadow-md"
              >
                <Wand2 className="h-4 w-4" />
                Rename {readyEntries.length} File
                {readyEntries.length === 1 ? "" : "s"}
              </Button>
            </footer>
          </div>
        </div>
      )}

      {/* Confirmation Dialog (FR-19) */}
      <RenameConfirmationDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        readyEntries={readyEntries}
        skippedCount={session.counts.skipped}
        needsReviewCount={session.counts.needsReview}
        isExecuting={isExecuting}
        onConfirmExecute={handleExecuteConfirmedRename}
      />

      {/* Execution Summary Dialog (FR-22) */}
      <BatchResultDialog
        result={lastBatchResult}
        open={resultModalOpen}
        onOpenChange={setResultModalOpen}
        onUndoBatch={handleUndoLastBatch}
      />
    </div>
  );
}
