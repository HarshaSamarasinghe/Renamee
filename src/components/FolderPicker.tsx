import React, { useEffect, useState } from "react";
import {
  FilePlus2,
  FileVideo,
  FolderOpen,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface FolderPickerProps {
  scannedFolder: string;
  recursive: boolean;
  isScanning: boolean;
  canUndo: boolean;
  undoCount: number;
  onChooseFolder: () => void;
  onScanTypedFolder: (folderPath: string) => void;
  onAddFiles: () => void;
  onLoadSampleSandbox: () => void;
  onToggleRecursive: (recursive: boolean) => void;
  onRescan: () => void;
  onUndoLastBatch: () => void;
}

export const FolderPicker: React.FC<FolderPickerProps> = ({
  scannedFolder,
  recursive,
  isScanning,
  canUndo,
  undoCount,
  onChooseFolder,
  onScanTypedFolder,
  onAddFiles,
  onLoadSampleSandbox,
  onToggleRecursive,
  onRescan,
  onUndoLastBatch,
}) => {
  const [pathInput, setPathInput] = useState(scannedFolder);

  useEffect(() => {
    setPathInput(scannedFolder);
  }, [scannedFolder]);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 bg-card/40 px-6 py-2.5">
      <div className="flex flex-1 flex-wrap items-center gap-2 min-w-[320px]">
        <Button onClick={onChooseFolder} size="sm" className="shrink-0">
          <FolderOpen className="h-3.5 w-3.5" />
          Choose Folder
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={onAddFiles}
          className="shrink-0"
        >
          <FilePlus2 className="h-3.5 w-3.5" />
          Add Files
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={onLoadSampleSandbox}
          className="shrink-0"
          title="Create & load a real disposable sample folder on disk with Trigger S01E01..S01E10 test files"
        >
          <FileVideo className="h-3.5 w-3.5 text-emerald-500" />
          Load Sample Folder
        </Button>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (pathInput.trim()) {
              onScanTypedFolder(pathInput.trim());
            }
          }}
          className="flex flex-1 items-center gap-1.5 min-w-[260px]"
        >
          <Input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder="Paste or type a Windows folder path (e.g. D:\Videos\Show) and press Enter..."
            aria-label="Folder path on disk"
            className="h-8 font-mono text-xs"
          />
          {pathInput.trim() && pathInput.trim() !== scannedFolder && (
            <Button type="submit" variant="secondary" size="sm" className="h-8">
              Load Path
            </Button>
          )}
        </form>

        {scannedFolder && (
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={onRescan}
            disabled={isScanning}
            aria-label="Rescan current folder"
            title="Rescan Folder"
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", isScanning && "animate-spin")}
            />
          </Button>
        )}
      </div>

      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
          <Checkbox
            checked={recursive}
            onCheckedChange={(c) => onToggleRecursive(Boolean(c))}
            aria-label="Include subfolders recursively"
          />
          <span>Include subfolders</span>
        </label>

        <Button
          variant="outline"
          size="sm"
          disabled={!canUndo}
          onClick={onUndoLastBatch}
          title="Safely undo the most recent completed rename batch on disk"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Undo ({undoCount})
        </Button>
      </div>
    </div>
  );
};
