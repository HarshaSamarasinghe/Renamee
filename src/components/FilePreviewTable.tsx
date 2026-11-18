import React, { useState } from "react";
import {
  ArrowRight,
  ArrowUpDown,
  Edit3,
  RotateCcw,
  Search,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "./StatusBadge";
import { SortDirection, SortField } from "@/features/renamer/api";
import { formatNumberMinWidth2 } from "@/features/renamer/format";
import { FileEntry } from "@/features/renamer/types";
import { cn, formatBytes } from "@/lib/utils";

export type FilterTabId =
  | "all"
  | "ready"
  | "needs_review"
  | "conflict"
  | "skipped";

interface FilePreviewTableProps {
  entries: FileEntry[];
  counts: {
    total: number;
    ready: number;
    needsReview: number;
    conflicts: number;
    skipped: number;
  };
  statusFilter: FilterTabId;
  onChangeStatusFilter: (tab: FilterTabId) => void;
  searchQuery: string;
  onChangeSearchQuery: (q: string) => void;
  sortField: SortField;
  sortDirection: SortDirection;
  onChangeSort: (field: SortField) => void;
  onToggleRowInclusion: (id: string, include: boolean) => void;
  onToggleSelectAll: (includeAll: boolean) => void;
  onCommitRowManualName: (id: string, newName: string | null) => void;
}

export const FilePreviewTable: React.FC<FilePreviewTableProps> = ({
  entries,
  counts,
  statusFilter,
  onChangeStatusFilter,
  searchQuery,
  onChangeSearchQuery,
  sortField,
  sortDirection,
  onChangeSort,
  onToggleRowInclusion,
  onToggleSelectAll,
  onCommitRowManualName,
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState<string>("");
  const [visibleLimit, setVisibleLimit] = useState<number>(250);

  const visibleEntries =
    entries.length > visibleLimit ? entries.slice(0, visibleLimit) : entries;

  const startEdit = (entry: FileEntry) => {
    setEditingId(entry.id);
    setEditingValue(entry.proposedName ?? entry.originalName);
  };

  const commitEdit = (id: string) => {
    const trimmed = editingValue.trim();
    setEditingId(null);
    if (trimmed) {
      onCommitRowManualName(id, trimmed);
    }
  };

  const selectableEntries = entries.filter((e) => e.proposedName !== null);
  const allSelected =
    selectableEntries.length > 0 &&
    selectableEntries.every((e) => e.selected);

  const filterTabs: { id: FilterTabId; label: string; count: number }[] = [
    { id: "all", label: "All", count: counts.total },
    { id: "ready", label: "Ready", count: counts.ready },
    { id: "needs_review", label: "Needs Review", count: counts.needsReview },
    { id: "conflict", label: "Conflicts", count: counts.conflicts },
    { id: "skipped", label: "Excluded", count: counts.skipped },
  ];

  return (
    <div className="flex flex-1 flex-col overflow-hidden p-4 gap-3">
      {/* Filter Bar + Search + Display Sort */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div
          className="flex items-center gap-1 rounded-lg border border-border bg-card/70 p-1"
          role="tablist"
          aria-label="Filter files by status"
        >
          {filterTabs.map((tab) => {
            const active = statusFilter === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onChangeStatusFilter(tab.id)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  active
                    ? "bg-primary text-primary-foreground shadow-xs"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                <span>{tab.label}</span>
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.2 text-[10px]",
                    active
                      ? "bg-primary-foreground/20 text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {tab.count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <div className="relative w-64">
            <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => onChangeSearchQuery(e.target.value)}
              placeholder="Search original or proposed name..."
              aria-label="Search filenames"
              className="pl-8 text-xs h-8"
            />
          </div>
        </div>
      </div>

      {/* Scrollable Preview Table */}
      <div className="flex-1 overflow-auto rounded-xl border border-border bg-card/70 shadow-xs">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="sticky top-0 z-10 border-b border-border bg-muted/95 backdrop-blur-md text-muted-foreground">
            <tr>
              <th className="w-10 px-3.5 py-2.5">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={(c) => onToggleSelectAll(Boolean(c))}
                  aria-label="Select or deselect all parsed rows"
                />
              </th>
              <th className="px-3 py-2.5 font-semibold">
                <button
                  type="button"
                  onClick={() => onChangeSort("originalName")}
                  className="inline-flex items-center gap-1 hover:text-foreground"
                >
                  <span>Original Name</span>
                  <ArrowUpDown className="h-3 w-3 opacity-70" />
                </button>
              </th>
              <th className="w-8 px-1 py-2.5 text-center"></th>
              <th className="px-3 py-2.5 font-semibold">
                <button
                  type="button"
                  onClick={() => onChangeSort("proposedName")}
                  className="inline-flex items-center gap-1 hover:text-foreground"
                >
                  <span>Proposed Name (Click to Edit)</span>
                  <ArrowUpDown className="h-3 w-3 opacity-70" />
                </button>
              </th>
              <th className="px-3 py-2.5 font-semibold">
                <button
                  type="button"
                  onClick={() => onChangeSort("episode")}
                  className="inline-flex items-center gap-1 hover:text-foreground"
                >
                  <span>Series / Season / Episode</span>
                  <ArrowUpDown className="h-3 w-3 opacity-70" />
                </button>
              </th>
              <th className="px-3.5 py-2.5 font-semibold text-right">
                <button
                  type="button"
                  onClick={() => onChangeSort("status")}
                  className="inline-flex items-center gap-1 hover:text-foreground"
                >
                  <span>Status</span>
                  <ArrowUpDown className="h-3 w-3 opacity-70" />
                </button>
              </th>
            </tr>
          </thead>

          <tbody className="divide-y divide-border/60">
            {entries.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="py-12 text-center text-xs text-muted-foreground"
                >
                  No files match the current filter or search query.
                </td>
              </tr>
            ) : (
              visibleEntries.map((entry) => {
                const isEditing = editingId === entry.id;
                const isManuallyEdited = Boolean(entry.manualEditedName);

                return (
                  <tr
                    key={entry.id}
                    className={cn(
                      "group transition-colors hover:bg-accent/40",
                      entry.selected &&
                        entry.status === "ready" &&
                        "bg-primary/[0.03]"
                    )}
                  >
                    <td className="px-3.5 py-2.5 align-middle">
                      <Checkbox
                        checked={entry.selected}
                        disabled={!entry.proposedName}
                        onCheckedChange={(c) =>
                          onToggleRowInclusion(entry.id, Boolean(c))
                        }
                        aria-label={`Include ${entry.originalName}`}
                      />
                    </td>

                    {/* Original Filename */}
                    <td className="px-3 py-2.5 align-middle max-w-[300px]">
                      <div
                        className="font-mono text-xs truncate text-foreground select-text"
                        title={entry.originalName}
                      >
                        {entry.originalName}
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5">
                        <span>{formatBytes(entry.sizeBytes)}</span>
                        <span>•</span>
                        <span className="font-mono">
                          Ext: {entry.extension || "none"}
                        </span>
                      </div>
                    </td>

                    <td className="px-1 py-2.5 align-middle text-center">
                      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground inline" />
                    </td>

                    {/* Proposed Name (Inline Editable) */}
                    <td className="px-3 py-2.5 align-middle min-w-[260px]">
                      {isEditing ? (
                        <Input
                          autoFocus
                          value={editingValue}
                          onChange={(e) => setEditingValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitEdit(entry.id);
                            if (e.key === "Escape") setEditingId(null);
                          }}
                          onBlur={() => commitEdit(entry.id)}
                          aria-label={`Edit proposed filename for ${entry.originalName}`}
                          className="h-7 font-mono text-xs"
                        />
                      ) : (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => startEdit(entry)}
                            className={cn(
                              "group/edit flex items-center gap-1.5 rounded px-1.5 py-0.5 -ml-1.5 text-left font-mono text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              entry.status === "ready" &&
                                "font-semibold text-emerald-600 dark:text-emerald-400",
                              entry.status === "needs_review" &&
                                "italic text-amber-600 dark:text-amber-400",
                              entry.status === "conflict" &&
                                "font-semibold text-rose-600 dark:text-rose-400",
                              entry.status === "skipped" &&
                                "text-muted-foreground"
                            )}
                            title="Click or press Enter to edit proposed filename"
                          >
                            <span>
                              {entry.proposedName ??
                                "Needs Review — Click to enter filename"}
                            </span>
                            <Edit3 className="h-3 w-3 shrink-0 opacity-0 group-hover/edit:opacity-75 transition-opacity" />
                          </button>

                          {isManuallyEdited && (
                            <button
                              type="button"
                              onClick={() =>
                                onCommitRowManualName(entry.id, null)
                              }
                              className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground underline hover:text-foreground"
                              title="Reset to automatic parsed filename"
                            >
                              <RotateCcw className="h-2.5 w-2.5" />
                              reset
                            </button>
                          )}
                        </div>
                      )}

                      {entry.issues.length > 0 && (
                        <div
                          className={cn(
                            "mt-0.5 text-[11px]",
                            entry.status === "conflict"
                              ? "text-rose-600 dark:text-rose-400"
                              : "text-amber-600 dark:text-amber-400"
                          )}
                        >
                          {entry.issues.join(" • ")}
                        </div>
                      )}
                    </td>

                    {/* Detected Series / Season / Episode */}
                    <td className="px-3 py-2.5 align-middle">
                      {entry.parsed ? (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline" className="font-medium">
                            {entry.parsed.series}
                          </Badge>
                          <Badge variant="secondary" className="font-mono">
                            S{formatNumberMinWidth2(entry.parsed.season)}
                          </Badge>
                          <Badge variant="secondary" className="font-mono">
                            E{formatNumberMinWidth2(entry.parsed.episode)}
                          </Badge>
                        </div>
                      ) : (
                        <span className="text-muted-foreground italic">
                          Ambiguous / Unrecognized
                        </span>
                      )}
                    </td>

                    {/* Status Badge */}
                    <td className="px-3.5 py-2.5 align-middle text-right">
                      <StatusBadge status={entry.status} />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>

        {entries.length > visibleLimit && (
          <div className="flex items-center justify-between border-t border-border/70 bg-muted/40 px-4 py-2.5 text-xs">
            <span className="text-muted-foreground">
              Showing first{" "}
              <span className="font-semibold text-foreground">
                {visibleLimit.toLocaleString()}
              </span>{" "}
              of{" "}
              <span className="font-semibold text-foreground">
                {entries.length.toLocaleString()}
              </span>{" "}
              files (bounded rendering keeps UI responsive for 10,000+ files)
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setVisibleLimit((l) => l + 500)}
                className="rounded border border-border bg-card px-2.5 py-1 font-medium hover:bg-accent"
              >
                Load +500 More
              </button>
              <button
                type="button"
                onClick={() => setVisibleLimit(entries.length)}
                className="rounded border border-border bg-card px-2.5 py-1 font-medium hover:bg-accent"
              >
                Show All ({entries.length.toLocaleString()})
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
