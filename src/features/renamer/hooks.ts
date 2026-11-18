// ============================================================================
// PHASE 2: REACT STATE HOOK FOR FOLDER SCANNING & LIVE PREVIEW
// ============================================================================

import { useCallback, useMemo, useState } from "react";
import {
  chooseFilesNativeDialog,
  chooseFolderNativeDialog,
  DEFAULT_SUPPORTED_EXTENSIONS,
  parsePreviewCommand,
  scanFolderCommand,
  scanPathsCommand,
   SortDirection,
  SortField,
  sortEntriesForDisplay,
} from "./api";
import {
  applyPreviewOverrides,
  DEFAULT_PATTERN,
  getSeriesSeasonGroupKey,
} from "./format";
import { validatePreviewBatch } from "./validation";
import {
  FileEntry,
  OutputPatternPreset,
  PreviewOverrides,
} from "./types";

export interface DetectedSeriesGroup {
  groupKey: string;
  detectedSeries: string;
  overrideSeries: string;
  season: number;
  episodeCount: number;
}

export function useRenamerSession() {
  const [scannedFolder, setScannedFolder] = useState<string>("");
  const [recursive, setRecursive] = useState<boolean>(false);
  const [supportedExtensions, setSupportedExtensions] = useState<string[]>(
    DEFAULT_SUPPORTED_EXTENSIONS
  );
  const [baseEntries, setBaseEntries] = useState<FileEntry[]>([]);
  const [scanErrors, setScanErrors] = useState<string[]>([]);
  const [isScanning, setIsScanning] = useState<boolean>(false);

  // User customization & preview overrides
  const [pattern, setPattern] = useState<OutputPatternPreset>(DEFAULT_PATTERN);
  const [seriesOverrides, setSeriesOverrides] = useState<Record<string, string>>(
    {}
  );
  const [manualRowNames, setManualRowNames] = useState<Record<string, string>>(
    {}
  );
  const [excludedIds, setExcludedIds] = useState<string[]>([]);

  // Display filter, search, and sort (never mutates episode numbers)
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "ready" | "needs_review" | "conflict" | "skipped"
  >("all");
  const [sortField, setSortField] = useState<SortField>("originalName");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

  const overrides: PreviewOverrides = useMemo(
    () => ({
      pattern,
      seriesOverrides,
      manualRowNames,
      excludedIds,
    }),
    [pattern, seriesOverrides, manualRowNames, excludedIds]
  );

  // Live preview computed deterministically from baseEntries + overrides + batch validation
  const previewEntries: FileEntry[] = useMemo(() => {
    const formatted = applyPreviewOverrides(baseEntries, overrides);
    return validatePreviewBatch(formatted);
  }, [baseEntries, overrides]);

  // Detected (Series + Season) groups for shared title editing (Section 5: never rewrites episode numbers)
  const seriesGroups: DetectedSeriesGroup[] = useMemo(() => {
    const map = new Map<string, DetectedSeriesGroup>();
    for (const entry of baseEntries) {
      if (!entry.parsed) continue;
      const key = getSeriesSeasonGroupKey(entry.parsed);
      const existing = map.get(key);
      if (existing) {
        existing.episodeCount += 1;
      } else {
        map.set(key, {
          groupKey: key,
          detectedSeries: entry.parsed.series,
          overrideSeries: seriesOverrides[key] ?? entry.parsed.series,
          season: entry.parsed.season,
          episodeCount: 1,
        });
      }
    }
    return Array.from(map.values());
  }, [baseEntries, seriesOverrides]);

  const displayEntries: FileEntry[] = useMemo(() => {
    const filtered = previewEntries.filter((entry) => {
      if (statusFilter !== "all" && entry.status !== statusFilter) {
        return false;
      }
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return (
        entry.originalName.toLowerCase().includes(q) ||
        (entry.proposedName && entry.proposedName.toLowerCase().includes(q)) ||
        (entry.parsed && entry.parsed.series.toLowerCase().includes(q))
      );
    });
    return sortEntriesForDisplay(filtered, sortField, sortDirection);
  }, [previewEntries, statusFilter, searchQuery, sortField, sortDirection]);

  const counts = useMemo(() => {
    let ready = 0;
    let needsReview = 0;
    let conflicts = 0;
    let skipped = 0;

    for (const e of previewEntries) {
      if (e.status === "ready") ready++;
      else if (e.status === "needs_review") needsReview++;
      else if (e.status === "conflict") conflicts++;
      else if (e.status === "skipped") skipped++;
    }

    return {
      total: previewEntries.length,
      ready,
      needsReview,
      conflicts,
      skipped,
    };
  }, [previewEntries]);

  const scanFolder = useCallback(
    async (targetFolder: string, useRecursive = recursive) => {
      if (!targetFolder) return;
      setIsScanning(true);
      try {
        const res = await scanFolderCommand(
          targetFolder,
          useRecursive,
          supportedExtensions
        );
        setScannedFolder(res.scannedFolder);
        setBaseEntries(res.entries);
        setScanErrors(res.scanErrors);
        setSeriesOverrides({});
        setManualRowNames({});
        setExcludedIds([]);
      } finally {
        setIsScanning(false);
      }
    },
    [recursive, supportedExtensions]
  );

  const pickAndScanFolder = useCallback(async () => {
    const chosen = await chooseFolderNativeDialog();
    if (chosen) {
      await scanFolder(chosen, recursive);
    }
  }, [scanFolder, recursive]);

  const pickAndScanFiles = useCallback(async () => {
    const chosen = await chooseFilesNativeDialog(supportedExtensions);
    if (chosen && chosen.length > 0) {
      setIsScanning(true);
      try {
        const res = await scanPathsCommand(
          chosen,
          recursive,
          supportedExtensions
        );
        setScannedFolder(res.scannedFolder);
        setBaseEntries(res.entries);
        setScanErrors(res.scanErrors);
      } finally {
        setIsScanning(false);
      }
    }
  }, [recursive, supportedExtensions]);

  const toggleRowInclusion = useCallback((id: string, include: boolean) => {
    setExcludedIds((prev) =>
      include ? prev.filter((item) => item !== id) : [...new Set([...prev, id])]
    );
  }, []);

  const setGroupSeriesTitle = useCallback((groupKey: string, title: string) => {
    setSeriesOverrides((prev) => ({
      ...prev,
      [groupKey]: title,
    }));
  }, []);

  const setRowManualName = useCallback((id: string, name: string | null) => {
    setManualRowNames((prev) => {
      const next = { ...prev };
      if (name === null || !name.trim()) {
        delete next[id];
      } else {
        next[id] = name;
      }
      return next;
    });
  }, []);

  const refreshBackendPreview = useCallback(async () => {
    return await parsePreviewCommand(baseEntries, overrides);
  }, [baseEntries, overrides]);

  return {
    scannedFolder,
    recursive,
    setRecursive,
    supportedExtensions,
    setSupportedExtensions,
    baseEntries,
    previewEntries,
    displayEntries,
    seriesGroups,
    scanErrors,
    isScanning,
    pattern,
    setPattern,
    searchQuery,
    setSearchQuery,
    statusFilter,
    setStatusFilter,
    sortField,
    setSortField,
    sortDirection,
    setSortDirection,
    counts,
    scanFolder,
    pickAndScanFolder,
    pickAndScanFiles,
    toggleRowInclusion,
    setGroupSeriesTitle,
    setRowManualName,
    refreshBackendPreview,
  };
}
