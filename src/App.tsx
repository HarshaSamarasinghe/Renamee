import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Edit3,
  FileVideo,
  FolderOpen,
  History,
  Info,
  Moon,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
  Tag,
  UploadCloud,
  Wand2,
  XCircle,
} from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  evaluateBatchStatuses,
  FileScanItem,
  pad2,
  parseFilename,
  RecognitionStatus,
  RenameBatchRecord,
  RenameRequestItem,
  splitStemAndExtension,
} from "@/lib/parser";
import {
  createSampleSandboxFolder,
  executeBatchRenameBridge,
  getUndoHistoryBridge,
  isTauriEnvironment,
  loadDroppedFilenamesIntoSandbox,
  pickFolderDialog,
  scanFolderItems,
  undoLastBatchBridge,
} from "@/lib/tauri-bridge";
import { cn, formatBytes } from "@/lib/utils";

type FilterTab = "all" | "ready" | "flagged" | "conflicts" | "unchanged";

export function App() {
  const [darkMode, setDarkMode] = useState(true);
  const [folderPath, setFolderPath] = useState<string>("");
  const [items, setItems] = useState<FileScanItem[]>([]);
  const [includeAllFiles, setIncludeAllFiles] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<FilterTab>("all");
  const [isDragging, setIsDragging] = useState(false);
  const [isScanning, setIsScanning] = useState(false);

  // Inline editing state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState<string>("");

  // Batch Series Override helper
  const [seriesOverride, setSeriesOverride] = useState<string>("");

  // Dialogs & notifications
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [patternTesterOpen, setPatternTesterOpen] = useState(false);
  const [testFilenameInput, setTestFilenameInput] = useState(
    "Trigger.S01E01.x265.720p.WEB-EDITH.mkv"
  );
  const [undoHistory, setUndoHistory] = useState<RenameBatchRecord[]>([]);
  const [bannerMessage, setBannerMessage] = useState<{
    type: "success" | "error" | "info";
    text: string;
  } | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }, [darkMode]);

  const loadFolder = useCallback(
    async (targetPath: string, includeAll = includeAllFiles) => {
      if (!targetPath) return;
      setIsScanning(true);
      try {
        const scanned = await scanFolderItems(targetPath, includeAll);
        const withSelection = scanned.map((item) => ({
          ...item,
          selected: item.parsed.status === "ready",
        }));
        setFolderPath(targetPath);
        setItems(withSelection);
        const history = await getUndoHistoryBridge();
        setUndoHistory(history);
      } catch (err) {
        setBannerMessage({
          type: "error",
          text: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setIsScanning(false);
      }
    },
    [includeAllFiles]
  );

  // Listen for native Tauri drag-drop events when running inside desktop WebView
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
            // If a file was dropped, use its parent directory; if a folder was dropped, scan it
            const lastSep = Math.max(
              firstPath.lastIndexOf("\\"),
              firstPath.lastIndexOf("/")
            );
            const hasExt = /\.[a-z0-9]{2,5}$/i.test(firstPath);
            const dirPath =
              hasExt && lastSep > 0 ? firstPath.slice(0, lastSep) : firstPath;
            loadFolder(dirPath);
          }
        } else {
          setIsDragging(false);
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        // Ignore if drag-drop listener isn't permitted in current context
      });

    return () => {
      if (unlisten) unlisten();
    };
  }, [loadFolder]);

  const handleSelectFolder = async () => {
    const picked = await pickFolderDialog();
    if (picked) {
      await loadFolder(picked);
    }
  };

  const handleLoadSampleSandbox = async () => {
    try {
      const sampleDir = await createSampleSandboxFolder();
      await loadFolder(sampleDir);
      setBannerMessage({
        type: "info",
        text: `Loaded sample test folder with Trigger S01E01–S01E04 and multi-pattern test files: ${sampleDir}`,
      });
    } catch (err) {
      setBannerMessage({
        type: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // HTML5 Drag & Drop support (works in browser preview and fallback contexts)
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (isTauriEnvironment()) return; // Handled by native Tauri onDragDropEvent

    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length > 0) {
      const virtualPath = loadDroppedFilenamesIntoSandbox(
        "Dropped Files Batch",
        droppedFiles.map((f) => ({ name: f.name, sizeBytes: f.size }))
      );
      await loadFolder(virtualPath, true);
      setBannerMessage({
        type: "info",
        text: `Analyzed ${droppedFiles.length} dropped file(s) offline.`,
      });
    }
  };

  const recomputeItems = useCallback((updated: FileScanItem[]) => {
    const existingSet = new Set(
      updated.map((i) => i.originalName.toLowerCase())
    );
    const reevaluated = evaluateBatchStatuses(updated, existingSet);
    setItems(
      reevaluated.map((item) => ({
        ...item,
        selected:
          item.parsed.status === "ready" ? (item.selected ?? true) : false,
      }))
    );
  }, []);

  const handleToggleSelect = (id: string, checked: boolean) => {
    setItems((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, selected: checked } : item
      )
    );
  };

  const handleSelectAllReady = (checked: boolean) => {
    setItems((prev) =>
      prev.map((item) =>
        item.parsed.status === "ready" ? { ...item, selected: checked } : item
      )
    );
  };

  const startInlineEdit = (item: FileScanItem) => {
    setEditingId(item.id);
    setEditingValue(item.customTargetName ?? item.parsed.suggestedName);
  };

  const commitInlineEdit = (id: string) => {
    const trimmed = editingValue.trim();
    const updated = items.map((item) => {
      if (item.id !== id) return item;
      if (!trimmed) return item;

      // Always preserve original file extension if user omitted it
      const { extension: origExt } = splitStemAndExtension(item.originalName);
      const finalName =
        origExt && !trimmed.toLowerCase().endsWith(origExt.toLowerCase())
          ? `${trimmed}${origExt}`
          : trimmed;

      return {
        ...item,
        customTargetName: finalName,
        selected: finalName !== item.originalName,
      };
    });

    setEditingId(null);
    recomputeItems(updated);
  };

  const resetCustomEdit = (id: string) => {
    const updated = items.map((item) => {
      if (item.id !== id) return item;
      const rawParsed = parseFilename(item.originalName);
      return {
        ...item,
        customTargetName: undefined,
        parsed: rawParsed,
        selected: rawParsed.status === "ready",
      };
    });
    recomputeItems(updated);
  };

  const applySeriesNameOverride = () => {
    const cleanOverride = seriesOverride.trim();
    if (!cleanOverride) return;

    const updated = items.map((item) => {
      if (item.parsed.season !== null && item.parsed.episode !== null) {
        const epPart =
          item.parsed.episodeEnd && item.parsed.episodeEnd > item.parsed.episode
            ? `S${pad2(item.parsed.season)}E${pad2(item.parsed.episode)}-E${pad2(item.parsed.episodeEnd)}`
            : `S${pad2(item.parsed.season)}E${pad2(item.parsed.episode)}`;
        const newTarget = `${cleanOverride} ${epPart}${item.parsed.extension}`;
        return {
          ...item,
          customTargetName: newTarget,
          selected: newTarget !== item.originalName,
        };
      }
      return item;
    });

    recomputeItems(updated);
    setBannerMessage({
      type: "info",
      text: `Applied series name "${cleanOverride}" to all recognized episodes.`,
    });
  };

  // Statistics and filtered rows
  const stats = useMemo(() => {
    let ready = 0;
    let selectedReady = 0;
    let flagged = 0;
    let conflicts = 0;
    let unchanged = 0;
    const detectedSeries = new Set<string>();

    for (const item of items) {
      if (item.parsed.seriesName) {
        detectedSeries.add(item.parsed.seriesName);
      }
      switch (item.parsed.status) {
        case "ready":
          ready++;
          if (item.selected) selectedReady++;
          break;
        case "ambiguous":
        case "unrecognized":
          flagged++;
          break;
        case "duplicate_target":
        case "disk_conflict":
        case "invalid_chars":
          conflicts++;
          break;
        case "unchanged":
          unchanged++;
          break;
      }
    }

    return {
      total: items.length,
      ready,
      selectedReady,
      flagged,
      conflicts,
      unchanged,
      seriesList: Array.from(detectedSeries),
    };
  }, [items]);

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      const targetName = item.customTargetName ?? item.parsed.suggestedName;
      const matchesQuery =
        !searchQuery.trim() ||
        item.originalName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        targetName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (item.parsed.seriesName &&
          item.parsed.seriesName
            .toLowerCase()
            .includes(searchQuery.toLowerCase()));

      if (!matchesQuery) return false;

      if (activeTab === "ready") return item.parsed.status === "ready";
      if (activeTab === "flagged")
        return (
          item.parsed.status === "ambiguous" ||
          item.parsed.status === "unrecognized"
        );
      if (activeTab === "conflicts")
        return (
          item.parsed.status === "duplicate_target" ||
          item.parsed.status === "disk_conflict" ||
          item.parsed.status === "invalid_chars"
        );
      if (activeTab === "unchanged") return item.parsed.status === "unchanged";
      return true;
    });
  }, [items, searchQuery, activeTab]);

  const selectedRenameRequests: RenameRequestItem[] = useMemo(() => {
    return items
      .filter((item) => item.selected && item.parsed.status === "ready")
      .map((item) => ({
        originalName: item.originalName,
        targetName: (item.customTargetName ?? item.parsed.suggestedName).trim(),
      }))
      .filter((req) => req.originalName !== req.targetName);
  }, [items]);

  const handleConfirmBatchRename = async () => {
    if (selectedRenameRequests.length === 0) return;
    setConfirmOpen(false);
    try {
      const result = await executeBatchRenameBridge(
        folderPath,
        selectedRenameRequests
      );
      if (result.success) {
        setBannerMessage({
          type: "success",
          text: `Successfully renamed ${result.renamedCount} file(s). You can undo this batch anytime.`,
        });
        await loadFolder(folderPath);
      } else {
        setBannerMessage({
          type: "error",
          text: `Rename aborted safely: ${result.errors.join(" | ")}`,
        });
      }
    } catch (err) {
      setBannerMessage({
        type: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleUndoLastBatch = async () => {
    try {
      const res = await undoLastBatchBridge();
      if (res.success) {
        setBannerMessage({
          type: "info",
          text: `Restored ${res.renamedCount} file(s) back to their original filenames.`,
        });
        if (folderPath) {
          await loadFolder(folderPath);
        }
        const history = await getUndoHistoryBridge();
        setUndoHistory(history);
      } else {
        setBannerMessage({
          type: "error",
          text: `Undo encountered errors: ${res.errors.join(", ")}`,
        });
      }
    } catch (err) {
      setBannerMessage({
        type: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const liveTestParsed = useMemo(
    () => parseFilename(testFilenameInput.trim()),
    [testFilenameInput]
  );

  return (
    <div
      className="flex h-screen w-screen flex-col bg-background text-foreground select-none overflow-hidden"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag Overlay */}
      {isDragging && (
        <div className="fixed inset-3 z-50 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-background/90 backdrop-blur-md transition-all">
          <UploadCloud className="h-16 w-16 text-primary animate-bounce mb-3" />
          <h3 className="text-xl font-semibold">
            Drop Folder or Video Files Here
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            Smart Bulk File Renamer will scan and analyze filenames offline
          </p>
        </div>
      )}

      {/* Windows 11 Mica-Inspired Header Bar */}
      <header className="flex items-center justify-between border-b border-border/80 bg-card/75 px-6 py-3.5 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary border border-primary/25 shadow-xs">
            <Wand2 className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold tracking-tight">
                Smart Bulk File Renamer
              </h1>
              <Badge variant="default" className="text-[10px] py-0 px-1.5">
                OFFLINE ENGINE
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Intelligent series, season & episode recognition with zero-overwrite protection
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPatternTesterOpen(true)}
            title="Test custom filenames against the recognition engine"
          >
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            Pattern Analyzer
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={handleLoadSampleSandbox}
            title="Create and load a safe temporary sample folder with Trigger S01E01..S01E04"
          >
            <FileVideo className="h-3.5 w-3.5 text-emerald-500" />
            Load Sample Folder
          </Button>

          <Button
            variant="outline"
            size="sm"
            disabled={undoHistory.length === 0}
            onClick={handleUndoLastBatch}
            title="Undo the most recent batch rename"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Undo ({undoHistory.length})
          </Button>

          <Button
            variant="ghost"
            size="icon"
            onClick={() => setHistoryOpen(true)}
            title="View Rename History"
          >
            <History className="h-4 w-4" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            onClick={() => setDarkMode((d) => !d)}
            title={darkMode ? "Switch to Light Theme" : "Switch to Dark Theme"}
          >
            {darkMode ? (
              <Sun className="h-4 w-4 text-amber-400" />
            ) : (
              <Moon className="h-4 w-4 text-slate-700" />
            )}
          </Button>
        </div>
      </header>

      {/* Top Toolbar: Folder Picker + Series Override + Stats */}
      <div className="border-b border-border/70 bg-card/40 px-6 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-1 items-center gap-2 min-w-[320px]">
            <Button onClick={handleSelectFolder} className="shrink-0">
              <FolderOpen className="h-4 w-4" />
              Select Folder
            </Button>

            <div className="flex flex-1 items-center gap-2 rounded-md border border-border bg-background/70 px-3 py-1.5 text-xs">
              <span className="text-muted-foreground font-medium shrink-0">
                Folder:
              </span>
              <span className="truncate font-mono text-foreground select-all">
                {folderPath || "No folder selected — choose a folder or click 'Load Sample Folder'"}
              </span>
            </div>

            {folderPath && (
              <Button
                variant="outline"
                size="icon"
                onClick={() => loadFolder(folderPath)}
                disabled={isScanning}
                title="Rescan Folder"
              >
                <RefreshCw
                  className={cn("h-4 w-4", isScanning && "animate-spin")}
                />
              </Button>
            )}
          </div>

          {/* Series Name Override Bar */}
          {items.length > 0 && (
            <div className="flex items-center gap-2">
              <Input
                value={seriesOverride}
                onChange={(e) => setSeriesOverride(e.target.value)}
                placeholder="Override series name (e.g. Trigger)..."
                className="w-56 text-xs h-8"
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={applySeriesNameOverride}
                disabled={!seriesOverride.trim()}
              >
                Apply to Batch
              </Button>
            </div>
          )}
        </div>

        {/* Status Notification Banner */}
        {bannerMessage && (
          <div
            className={cn(
              "mt-3 flex items-center justify-between rounded-lg border px-3.5 py-2 text-xs transition-all",
              bannerMessage.type === "success" &&
                "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
              bannerMessage.type === "error" &&
                "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300",
              bannerMessage.type === "info" &&
                "border-primary/30 bg-primary/10 text-primary"
            )}
          >
            <div className="flex items-center gap-2">
              {bannerMessage.type === "success" && (
                <CheckCircle2 className="h-4 w-4 shrink-0" />
              )}
              {bannerMessage.type === "error" && (
                <XCircle className="h-4 w-4 shrink-0" />
              )}
              {bannerMessage.type === "info" && (
                <Info className="h-4 w-4 shrink-0" />
              )}
              <span>{bannerMessage.text}</span>
            </div>
            <button
              onClick={() => setBannerMessage(null)}
              className="text-xs underline opacity-75 hover:opacity-100 ml-4"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>

      {/* Main Content Area */}
      {items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
          <div className="max-w-lg rounded-2xl border border-border/80 bg-card/60 p-8 shadow-lg backdrop-blur-xs">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/15 text-primary border border-primary/20">
              <FolderOpen className="h-7 w-7" />
            </div>
            <h2 className="text-lg font-semibold">
              Select or Drop a Video Folder to Begin
            </h2>
            <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
              Automatically detects series titles, seasons, and episode numbers
              (such as <code className="text-foreground">S01E01</code>,{" "}
              <code className="text-foreground">s1e1</code>,{" "}
              <code className="text-foreground">1x01</code>), strips release tags
              (<code className="text-foreground">x265</code>,{" "}
              <code className="text-foreground">720p</code>,{" "}
              <code className="text-foreground">WEB-EDITH</code>), and generates
              clean filenames like{" "}
              <span className="font-semibold text-primary">
                Trigger S01E01.mkv
              </span>
              .
            </p>

            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <Button onClick={handleSelectFolder} size="lg">
                <FolderOpen className="h-4 w-4" />
                Browse Folder...
              </Button>
              <Button
                variant="outline"
                size="lg"
                onClick={handleLoadSampleSandbox}
              >
                <Sparkles className="h-4 w-4 text-primary" />
                Try with Sample "Trigger" Files
              </Button>
            </div>

            <div className="mt-6 grid grid-cols-3 gap-2.5 border-t border-border/60 pt-5 text-left text-[11px] text-muted-foreground">
              <div className="rounded-lg bg-background/60 p-2.5 border border-border/50">
                <div className="font-semibold text-foreground flex items-center gap-1.5 mb-0.5">
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
                  Zero Overwrite
                </div>
                Checks disk & batch conflicts before touching any file.
              </div>
              <div className="rounded-lg bg-background/60 p-2.5 border border-border/50">
                <div className="font-semibold text-foreground flex items-center gap-1.5 mb-0.5">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                  No Guessing
                </div>
                Flags ambiguous files instead of inventing episode numbers.
              </div>
              <div className="rounded-lg bg-background/60 p-2.5 border border-border/50">
                <div className="font-semibold text-foreground flex items-center gap-1.5 mb-0.5">
                  <RotateCcw className="h-3.5 w-3.5 text-primary" />
                  Full Undo
                </div>
                Two-phase atomic rename with one-click batch rollback.
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-hidden px-6 py-4 gap-3">
          {/* Filter Tabs & Search Row */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 rounded-lg border border-border bg-card/70 p-1">
              {(
                [
                  { id: "all", label: "All Files", count: stats.total },
                  { id: "ready", label: "Ready to Rename", count: stats.ready },
                  {
                    id: "flagged",
                    label: "Ambiguous / Unrecognized",
                    count: stats.flagged,
                  },
                  {
                    id: "conflicts",
                    label: "Conflicts",
                    count: stats.conflicts,
                  },
                  {
                    id: "unchanged",
                    label: "Already Clean",
                    count: stats.unchanged,
                  },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    activeTab === tab.id
                      ? "bg-primary text-primary-foreground shadow-xs"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                >
                  <span>{tab.label}</span>
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-0.2 text-[10px]",
                      activeTab === tab.id
                        ? "bg-primary-foreground/20 text-primary-foreground"
                        : "bg-muted text-muted-foreground"
                    )}
                  >
                    {tab.count}
                  </span>
                </button>
              ))}
            </div>

            <div className="flex items-center gap-3">
              {stats.seriesList.length > 0 && (
                <div className="hidden lg:flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span>Detected Series:</span>
                  {stats.seriesList.slice(0, 3).map((s) => (
                    <Badge key={s} variant="secondary">
                      {s}
                    </Badge>
                  ))}
                  {stats.seriesList.length > 3 && (
                    <Badge variant="outline">
                      +{stats.seriesList.length - 3} more
                    </Badge>
                  )}
                </div>
              )}

              <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                <Checkbox
                  checked={includeAllFiles}
                  onCheckedChange={(checked) => {
                    const val = Boolean(checked);
                    setIncludeAllFiles(val);
                    if (folderPath) loadFolder(folderPath, val);
                  }}
                />
                <span>Include non-video files</span>
              </label>

              <div className="relative w-60">
                <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter filenames or series..."
                  className="pl-8 text-xs h-8"
                />
              </div>
            </div>
          </div>

          {/* Live Before-and-After Preview Table */}
          <div className="flex-1 overflow-auto rounded-xl border border-border bg-card/70 shadow-xs">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="sticky top-0 z-10 border-b border-border bg-muted/90 backdrop-blur-md text-muted-foreground">
                <tr>
                  <th className="w-10 px-3.5 py-2.5">
                    <Checkbox
                      checked={
                        stats.ready > 0 && stats.selectedReady === stats.ready
                      }
                      onCheckedChange={(c) => handleSelectAllReady(Boolean(c))}
                      aria-label="Select all ready files"
                    />
                  </th>
                  <th className="px-3 py-2.5 font-semibold">
                    Original Filename (Before)
                  </th>
                  <th className="w-8 px-1 py-2.5 text-center"></th>
                  <th className="px-3 py-2.5 font-semibold">
                    New Clean Filename (After — Click to Edit)
                  </th>
                  <th className="px-3 py-2.5 font-semibold">
                    Detected Metadata
                  </th>
                  <th className="px-3 py-2.5 font-semibold">Removed Tags</th>
                  <th className="px-3.5 py-2.5 font-semibold text-right">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {filteredItems.map((item) => {
                  const targetName =
                    item.customTargetName ?? item.parsed.suggestedName;
                  const isEdited =
                    item.customTargetName !== undefined &&
                    item.customTargetName !== item.parsed.suggestedName;
                  const isEditingThis = editingId === item.id;

                  return (
                    <tr
                      key={item.id}
                      className={cn(
                        "group transition-colors hover:bg-accent/40",
                        item.selected && "bg-primary/[0.03]"
                      )}
                    >
                      <td className="px-3.5 py-2.5 align-middle">
                        <Checkbox
                          checked={Boolean(item.selected)}
                          disabled={item.parsed.status !== "ready"}
                          onCheckedChange={(c) =>
                            handleToggleSelect(item.id, Boolean(c))
                          }
                        />
                      </td>

                      {/* Original Filename */}
                      <td className="px-3 py-2.5 align-middle max-w-[300px]">
                        <div
                          className="font-mono text-xs truncate text-foreground select-text"
                          title={item.originalName}
                        >
                          {item.originalName}
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {formatBytes(item.sizeBytes)} • Ext:{" "}
                          <span className="font-mono text-foreground">
                            {item.parsed.extension || "none"}
                          </span>
                        </div>
                      </td>

                      <td className="px-1 py-2.5 align-middle text-center">
                        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground inline" />
                      </td>

                      {/* Generated / Editable Target Filename */}
                      <td className="px-3 py-2.5 align-middle min-w-[260px]">
                        {isEditingThis ? (
                          <div className="flex items-center gap-1.5">
                            <Input
                              autoFocus
                              value={editingValue}
                              onChange={(e) => setEditingValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") commitInlineEdit(item.id);
                                if (e.key === "Escape") setEditingId(null);
                              }}
                              onBlur={() => commitInlineEdit(item.id)}
                              className="h-7 font-mono text-xs"
                            />
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => startInlineEdit(item)}
                              className={cn(
                                "group/edit flex items-center gap-1.5 text-left font-mono text-xs rounded px-1.5 py-0.5 -ml-1.5 hover:bg-accent transition-colors",
                                item.parsed.status === "ready" &&
                                  "font-semibold text-emerald-600 dark:text-emerald-400",
                                (item.parsed.status === "ambiguous" ||
                                  item.parsed.status === "unrecognized") &&
                                  "text-amber-600 dark:text-amber-400",
                                (item.parsed.status === "duplicate_target" ||
                                  item.parsed.status === "disk_conflict" ||
                                  item.parsed.status === "invalid_chars") &&
                                  "text-rose-600 dark:text-rose-400"
                              )}
                              title="Click to customize target filename"
                            >
                              <span>{targetName}</span>
                              <Edit3 className="h-3 w-3 opacity-0 group-hover/edit:opacity-70 transition-opacity shrink-0" />
                            </button>
                            {isEdited && (
                              <button
                                type="button"
                                onClick={() => resetCustomEdit(item.id)}
                                className="text-[10px] text-muted-foreground underline hover:text-foreground"
                                title="Reset to automatic name"
                              >
                                reset
                              </button>
                            )}
                          </div>
                        )}
                        {item.parsed.reason && (
                          <div className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                            {item.parsed.reason}
                          </div>
                        )}
                      </td>

                      {/* Detected Series / Season / Episode */}
                      <td className="px-3 py-2.5 align-middle">
                        {item.parsed.seriesName ? (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant="outline" className="font-medium">
                              {item.parsed.seriesName}
                            </Badge>
                            {item.parsed.season !== null && (
                              <Badge variant="secondary" className="font-mono">
                                S{pad2(item.parsed.season)}
                              </Badge>
                            )}
                            {item.parsed.episode !== null && (
                              <Badge variant="secondary" className="font-mono">
                                E{pad2(item.parsed.episode)}
                                {item.parsed.episodeEnd
                                  ? `-E${pad2(item.parsed.episodeEnd)}`
                                  : ""}
                              </Badge>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground italic">
                            Not detected
                          </span>
                        )}
                      </td>

                      {/* Stripped Metadata Tags */}
                      <td className="px-3 py-2.5 align-middle max-w-[220px]">
                        {item.parsed.removedTags.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {item.parsed.removedTags.slice(0, 5).map((t, i) => (
                              <span
                                key={`${t}-${i}`}
                                className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground line-through"
                              >
                                {t}
                              </span>
                            ))}
                            {item.parsed.removedTags.length > 5 && (
                              <span className="text-[10px] text-muted-foreground">
                                +{item.parsed.removedTags.length - 5}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>

                      {/* Status Badge */}
                      <td className="px-3.5 py-2.5 align-middle text-right">
                        <StatusPill status={item.parsed.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Bottom Action Bar with Prominent Rename Files Button */}
          <footer className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card/85 px-5 py-3 shadow-sm backdrop-blur-md">
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <div>
                <span className="text-muted-foreground">Selected to rename:</span>{" "}
                <span className="font-semibold text-foreground">
                  {selectedRenameRequests.length} of {stats.total} file(s)
                </span>
              </div>
              {stats.flagged > 0 && (
                <div className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <span>
                    {stats.flagged} flagged file(s) skipped automatically (click any filename to edit manually)
                  </span>
                </div>
              )}
              {stats.conflicts > 0 && (
                <div className="flex items-center gap-1 text-rose-600 dark:text-rose-400">
                  <XCircle className="h-3.5 w-3.5" />
                  <span>
                    {stats.conflicts} conflict(s) blocked from overwriting
                  </span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-3">
              <Button
                size="lg"
                disabled={selectedRenameRequests.length === 0}
                onClick={() => setConfirmOpen(true)}
                className="px-8 shadow-md"
              >
                <Wand2 className="h-4 w-4" />
                Rename {selectedRenameRequests.length} File
                {selectedRenameRequests.length === 1 ? "" : "s"}
              </Button>
            </div>
          </footer>
        </div>
      )}

      {/* Confirmation Dialog Before Performing Actual Renaming (Requirement #14) */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              Confirm Batch File Rename
            </DialogTitle>
            <DialogDescription>
              You are about to rename{" "}
              <span className="font-semibold text-foreground">
                {selectedRenameRequests.length}
              </span>{" "}
              file(s) in <code className="text-xs">{folderPath}</code>. Existing
              files will never be overwritten, and you can undo this operation
              with a single click.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-72 overflow-y-auto rounded-lg border border-border bg-background/60 p-3 space-y-2 text-xs font-mono">
            {selectedRenameRequests.map((req) => (
              <div
                key={req.originalName}
                className="flex items-center justify-between gap-2 border-b border-border/50 pb-1.5 last:border-none last:pb-0"
              >
                <span className="truncate text-muted-foreground">
                  {req.originalName}
                </span>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-primary" />
                <span className="truncate font-semibold text-emerald-600 dark:text-emerald-400">
                  {req.targetName}
                </span>
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleConfirmBatchRename}>
              Confirm & Rename {selectedRenameRequests.length} File
              {selectedRenameRequests.length === 1 ? "" : "s"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Interactive Pattern Analyzer Modal */}
      <Dialog open={patternTesterOpen} onOpenChange={setPatternTesterOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              Live Filename Pattern Analyzer
            </DialogTitle>
            <DialogDescription>
              Test how the offline regex engine parses any release filename.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2 text-xs">
            <div>
              <label className="font-medium text-muted-foreground mb-1 block">
                Input Filename:
              </label>
              <Input
                value={testFilenameInput}
                onChange={(e) => setTestFilenameInput(e.target.value)}
                className="font-mono text-xs"
              />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {[
                  "Trigger.S01E01.x265.720p.WEB-EDITH.mkv",
                  "Severance_s1e9_1080p_WEB-DL.mp4",
                  "The.Last.Of.Us.1x05.BluRay.1080p.x264.mkv",
                  "Arcane - Season 2 Episode 3 - 2160p HDR.mkv",
                  "Mystery_Clip_Ep05_720p.mkv",
                ].map((sample) => (
                  <button
                    key={sample}
                    type="button"
                    onClick={() => setTestFilenameInput(sample)}
                    className="rounded border border-border bg-secondary/50 px-2 py-0.5 font-mono text-[10px] hover:bg-accent"
                  >
                    {sample}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-border bg-background/70 p-4 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Generated Output:</span>
                <span className="font-mono text-sm font-semibold text-primary">
                  {liveTestParsed.suggestedName}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 pt-2 border-t border-border/60">
                <div>
                  <span className="text-muted-foreground">Series Name:</span>{" "}
                  <span className="font-semibold">
                    {liveTestParsed.seriesName ?? "—"}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Season / Episode:</span>{" "}
                  <span className="font-mono font-semibold">
                    {liveTestParsed.season !== null
                      ? `S${pad2(liveTestParsed.season)}`
                      : "—"}{" "}
                    /{" "}
                    {liveTestParsed.episode !== null
                      ? `E${pad2(liveTestParsed.episode)}`
                      : "—"}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Extension:</span>{" "}
                  <span className="font-mono">{liveTestParsed.extension}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Pattern Rule:</span>{" "}
                  <span>{liveTestParsed.patternMatched ?? "None"}</span>
                </div>
              </div>
              <div className="pt-2 border-t border-border/60">
                <span className="text-muted-foreground block mb-1">
                  Removed Release Metadata Tags:
                </span>
                <div className="flex flex-wrap gap-1">
                  {liveTestParsed.removedTags.length > 0 ? (
                    liveTestParsed.removedTags.map((t, i) => (
                      <Badge key={`${t}-${i}`} variant="secondary">
                        <Tag className="h-2.5 w-2.5 mr-1" />
                        {t}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-muted-foreground">None</span>
                  )}
                </div>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button onClick={() => setPatternTesterOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Undo History Dialog */}
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="h-5 w-5 text-primary" />
              Batch Rename History (Undo Stack)
            </DialogTitle>
            <DialogDescription>
              Every batch rename is recorded in memory so you can safely revert
              changes.
            </DialogDescription>
          </DialogHeader>

          {undoHistory.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              No batch rename operations recorded in this session yet.
            </div>
          ) : (
            <div className="max-h-72 overflow-y-auto space-y-3 text-xs">
              {undoHistory
                .slice()
                .reverse()
                .map((batch) => (
                  <div
                    key={batch.batchId}
                    className="rounded-lg border border-border bg-background/60 p-3"
                  >
                    <div className="flex items-center justify-between font-medium mb-1.5">
                      <span className="truncate font-mono text-[11px]">
                        {batch.folderPath}
                      </span>
                      <Badge variant="secondary">
                        {batch.operations.length} file(s)
                      </Badge>
                    </div>
                    <div className="space-y-1 font-mono text-[11px] text-muted-foreground max-h-28 overflow-y-auto">
                      {batch.operations.map((op) => (
                        <div
                          key={op.originalName}
                          className="flex items-center gap-1.5"
                        >
                          <span className="truncate">{op.originalName}</span>
                          <ArrowRight className="h-3 w-3 shrink-0" />
                          <span className="truncate text-foreground">
                            {op.newName}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
            </div>
          )}

          <DialogFooter>
            {undoHistory.length > 0 && (
              <Button
                variant="outline"
                onClick={async () => {
                  await handleUndoLastBatch();
                  setHistoryOpen(false);
                }}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Undo Latest Batch
              </Button>
            )}
            <Button onClick={() => setHistoryOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatusPill({ status }: { status: RecognitionStatus }) {
  switch (status) {
    case "ready":
      return (
        <Badge variant="success">
          <CheckCircle2 className="h-3 w-3" />
          Ready
        </Badge>
      );
    case "unchanged":
      return <Badge variant="secondary">Already Clean</Badge>;
    case "ambiguous":
      return (
        <Badge variant="warning">
          <AlertTriangle className="h-3 w-3" />
          Ambiguous
        </Badge>
      );
    case "unrecognized":
      return (
        <Badge variant="warning">
          <AlertTriangle className="h-3 w-3" />
          Unrecognized
        </Badge>
      );
    case "duplicate_target":
      return (
        <Badge variant="destructive">
          <XCircle className="h-3 w-3" />
          Duplicate Name
        </Badge>
      );
    case "disk_conflict":
      return (
        <Badge variant="destructive">
          <XCircle className="h-3 w-3" />
          File Exists
        </Badge>
      );
    case "invalid_chars":
      return (
        <Badge variant="destructive">
          <XCircle className="h-3 w-3" />
          Invalid Name
        </Badge>
      );
  }
}
