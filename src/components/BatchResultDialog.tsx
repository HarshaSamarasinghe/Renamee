import React, { useState } from "react";
import { Check, CheckCircle2, Copy, RotateCcw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BatchResult } from "@/features/renamer/types";

interface BatchResultDialogProps {
  result: BatchResult | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUndoBatch: () => void;
}

export const BatchResultDialog: React.FC<BatchResultDialogProps> = ({
  result,
  open,
  onOpenChange,
  onUndoBatch,
}) => {
  const [copied, setCopied] = useState(false);

  if (!result) return null;

  const handleCopyReport = async () => {
    const lines = [
      `Operation ID: ${result.operationId}`,
      `Timestamp: ${result.timestamp}`,
      `Summary: ${result.summaryMessage}`,
      `Renamed: ${result.renamedCount}, Unchanged: ${result.unchangedCount}, Skipped: ${result.skippedCount}, Failed: ${result.failedCount}`,
      "",
      ...result.results.map(
        (r) =>
          `[${r.outcome.toUpperCase()}] ${r.fromPath} -> ${r.toPath}${
            r.message ? ` (${r.message})` : ""
          }`
      ),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard failure if restricted
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {result.failedCount === 0 ? (
              <CheckCircle2 className="h-5 w-5 text-emerald-500" />
            ) : (
              <XCircle className="h-5 w-5 text-amber-500" />
            )}
            Batch Rename Execution Summary
          </DialogTitle>
          <DialogDescription>{result.summaryMessage}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-4 gap-2 text-center text-xs">
          <div className="rounded-lg border border-border bg-background/60 p-2">
            <div className="text-base font-bold text-emerald-600 dark:text-emerald-400">
              {result.renamedCount}
            </div>
            <div className="text-[11px] text-muted-foreground">Renamed</div>
          </div>
          <div className="rounded-lg border border-border bg-background/60 p-2">
            <div className="text-base font-bold text-foreground">
              {result.unchangedCount}
            </div>
            <div className="text-[11px] text-muted-foreground">Unchanged</div>
          </div>
          <div className="rounded-lg border border-border bg-background/60 p-2">
            <div className="text-base font-bold text-muted-foreground">
              {result.skippedCount}
            </div>
            <div className="text-[11px] text-muted-foreground">Skipped</div>
          </div>
          <div className="rounded-lg border border-border bg-background/60 p-2">
            <div className="text-base font-bold text-rose-600 dark:text-rose-400">
              {result.failedCount}
            </div>
            <div className="text-[11px] text-muted-foreground">Failed</div>
          </div>
        </div>

        <div className="max-h-60 overflow-y-auto rounded-lg border border-border bg-background/60 p-3 space-y-1.5 text-xs font-mono">
          {result.results.map((item) => (
            <div
              key={item.fileId}
              className="flex flex-col border-b border-border/50 pb-1.5 last:border-none last:pb-0"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-muted-foreground">
                  {item.fromPath.split(/[\\/]/).pop()}
                </span>
                <span className="text-[10px] uppercase font-semibold">
                  {item.outcome}
                </span>
                <span className="truncate text-foreground">
                  {item.toPath.split(/[\\/]/).pop()}
                </span>
              </div>
              {item.message && (
                <div className="text-[11px] text-rose-500 mt-0.5">
                  {item.message}
                </div>
              )}
            </div>
          ))}
        </div>

        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <Button variant="outline" size="sm" onClick={handleCopyReport}>
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-500" />
                Copied Report
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                Copy Report
              </>
            )}
          </Button>

          <div className="flex items-center gap-2">
            {result.canUndo && result.renamedCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  onOpenChange(false);
                  onUndoBatch();
                }}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Undo Batch
              </Button>
            )}
            <Button size="sm" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
