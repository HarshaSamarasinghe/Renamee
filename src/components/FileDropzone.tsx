import React from "react";
import {
  AlertTriangle,
  FilePlus2,
  FolderOpen,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  UploadCloud,
} from "lucide-react";
import { Button } from "@/components/ui/button";

interface FileDropzoneProps {
  isDragging?: boolean;
  onChooseFolder: () => void;
  onAddFiles: () => void;
  onLoadSampleSandbox: () => void;
}

export const FileDropzone: React.FC<FileDropzoneProps> = ({
  isDragging = false,
  onChooseFolder,
  onAddFiles,
  onLoadSampleSandbox,
}) => {
  if (isDragging) {
    return (
      <div className="fixed inset-3 z-50 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-background/90 backdrop-blur-md transition-all">
        <UploadCloud className="h-14 w-14 text-primary animate-bounce mb-3" />
        <h3 className="text-lg font-semibold">
          Drop Folder or Video Files Here
        </h3>
        <p className="text-xs text-muted-foreground mt-1">
          Files will be scanned and previewed locally without modifying anything on disk
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
      <div className="max-w-xl rounded-2xl border border-border/80 bg-card/65 p-8 shadow-lg backdrop-blur-xs">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/15 text-primary border border-primary/20">
          <FolderOpen className="h-7 w-7" />
        </div>
        <h2 className="text-lg font-semibold">
          Choose a Folder or Add Video Files to Preview
        </h2>
        <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
          Automatically extracts series titles, seasons, and episode numbers from
          each filename (such as{" "}
          <code className="text-foreground">
            Trigger.S01E01.x265.720p.WEB-EDITH.mkv
          </code>{" "}
          →{" "}
          <span className="font-semibold text-primary">
            Trigger S01E01.mkv
          </span>
          ). Never renumbers by sort order, never guesses missing episodes, and
          never mutates files until you confirm.
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
          <Button onClick={onChooseFolder} size="lg">
            <FolderOpen className="h-4 w-4" />
            Choose Folder
          </Button>
          <Button variant="outline" size="lg" onClick={onAddFiles}>
            <FilePlus2 className="h-4 w-4" />
            Add Files
          </Button>
          <Button
            variant="secondary"
            size="lg"
            onClick={onLoadSampleSandbox}
          >
            <Sparkles className="h-4 w-4 text-primary" />
            Load Sample "Trigger" Folder
          </Button>
        </div>

        <div className="mt-6 grid grid-cols-3 gap-2.5 border-t border-border/60 pt-5 text-left text-[11px] text-muted-foreground">
          <div className="rounded-lg bg-background/60 p-2.5 border border-border/50">
            <div className="font-semibold text-foreground flex items-center gap-1.5 mb-0.5">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
              Zero Overwrite
            </div>
            Validates collisions, case-only renames, and file snapshots before execution.
          </div>
          <div className="rounded-lg bg-background/60 p-2.5 border border-border/50">
            <div className="font-semibold text-foreground flex items-center gap-1.5 mb-0.5">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
              Needs Review Guard
            </div>
            Flags ambiguous or unrecognized filenames instead of inventing episode numbers.
          </div>
          <div className="rounded-lg bg-background/60 p-2.5 border border-border/50">
            <div className="font-semibold text-foreground flex items-center gap-1.5 mb-0.5">
              <RotateCcw className="h-3.5 w-3.5 text-primary" />
              Safe Staged Undo
            </div>
            Tracks completed operations with identity checks for safe rollback.
          </div>
        </div>
      </div>
    </div>
  );
};
