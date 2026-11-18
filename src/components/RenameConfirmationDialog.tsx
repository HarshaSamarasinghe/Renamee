import React from "react";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FileEntry } from "@/features/renamer/types";

interface RenameConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  readyEntries: FileEntry[];
  skippedCount: number;
  needsReviewCount: number;
  isExecuting: boolean;
  onConfirmExecute: () => void;
}

export const RenameConfirmationDialog: React.FC<
  RenameConfirmationDialogProps
> = ({
  open,
  onOpenChange,
  readyEntries,
  skippedCount,
  needsReviewCount,
  isExecuting,
  onConfirmExecute,
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Confirm Batch File Rename
          </DialogTitle>
          <DialogDescription>
            Review the planned changes below. Only the{" "}
            <span className="font-semibold text-foreground">
              {readyEntries.length}
            </span>{" "}
            ready file(s) listed will be renamed within their original folders.
            {skippedCount > 0 && ` (${skippedCount} excluded/unchanged skipped.)`}
            {needsReviewCount > 0 &&
              ` (${needsReviewCount} Needs Review file(s) untouched.)`}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-72 overflow-y-auto rounded-lg border border-border bg-background/60 p-3 space-y-2 text-xs font-mono">
          {readyEntries.map((entry) => (
            <div
              key={entry.id}
              className="flex items-center justify-between gap-2 border-b border-border/50 pb-1.5 last:border-none last:pb-0"
            >
              <span className="truncate text-muted-foreground">
                {entry.originalName}
              </span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="truncate font-semibold text-emerald-600 dark:text-emerald-400">
                {entry.proposedName}
              </span>
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            disabled={isExecuting}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={isExecuting || readyEntries.length === 0}
            onClick={onConfirmExecute}
          >
            {isExecuting
              ? "Renaming Files..."
              : `Confirm & Rename ${readyEntries.length} File${
                  readyEntries.length === 1 ? "" : "s"
                }`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
