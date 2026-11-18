import React from "react";
import {
  Code2,
  Film,
  Layers,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { DEFAULT_SUPPORTED_EXTENSIONS } from "@/features/renamer/api";
import {
  CUSTOM_FORMAT_TOKENS,
  DEFAULT_PATTERN,
  formatEpisodeFilename,
  formatNumberMinWidth2,
  OUTPUT_PATTERNS,
} from "@/features/renamer/format";
import { DetectedSeriesGroup } from "@/features/renamer/hooks";
import { OutputPatternPreset } from "@/features/renamer/types";
import { cn } from "@/lib/utils";

interface RenameRulesPanelProps {
  pattern: OutputPatternPreset;
  onChangePattern: (pattern: OutputPatternPreset) => void;
  seriesGroups: DetectedSeriesGroup[];
  onChangeGroupSeries: (groupKey: string, newTitle: string) => void;
  supportedExtensions: string[];
  onChangeSupportedExtensions: (exts: string[]) => void;
}

export const RenameRulesPanel: React.FC<RenameRulesPanelProps> = ({
  pattern,
  onChangePattern,
  seriesGroups,
  onChangeGroupSeries,
  supportedExtensions,
  onChangeSupportedExtensions,
}) => {
  const handleToggleExt = (ext: string, checked: boolean) => {
    if (checked) {
      onChangeSupportedExtensions(
        Array.from(new Set([...supportedExtensions, ext]))
      );
    } else {
      const next = supportedExtensions.filter((e) => e !== ext);
      if (next.length > 0) {
        onChangeSupportedExtensions(next);
      }
    }
  };

  const sampleSeriesName =
    seriesGroups.length > 0
      ? seriesGroups[0].overrideSeries || seriesGroups[0].detectedSeries
      : "Trigger";
  const sampleSeason = seriesGroups.length > 0 ? seriesGroups[0].season : 1;

  const liveFormatPreview = formatEpisodeFilename(
    sampleSeriesName,
    sampleSeason,
    1,
    ".mkv",
    pattern
  );

  const handleInsertToken = (token: string) => {
    // Insert before {extension} if present at the end, otherwise append
    const extRegex = /(\{(?:extension|ext)\})$/i;
    if (extRegex.test(pattern)) {
      onChangePattern(pattern.replace(extRegex, `${token}$1`));
    } else {
      onChangePattern(`${pattern}${token}`);
    }
  };

  return (
    <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border/70 bg-card/35 p-4 text-xs">
      {/* Custom Naming Format Builder */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 font-semibold text-foreground">
            <Code2 className="h-3.5 w-3.5 text-primary" />
            <span>Custom Naming Format</span>
          </div>
          {pattern !== DEFAULT_PATTERN && (
            <button
              type="button"
              onClick={() => onChangePattern(DEFAULT_PATTERN)}
              className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground underline"
              title="Reset to default naming format"
            >
              <RotateCcw className="h-2.5 w-2.5" />
              Reset
            </button>
          )}
        </div>

        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Type any custom format using placeholders below. Your recognized
          files update in real time.
        </p>

        <Input
          value={pattern}
          onChange={(e) => onChangePattern(e.target.value)}
          placeholder="{series} S{season:02}E{episode:02}{extension}"
          aria-label="Custom naming format template"
          className="h-8 font-mono text-xs"
        />

        {/* Live Sample Output Preview */}
        <div className="rounded-lg border border-primary/25 bg-primary/10 px-2.5 py-2">
          <div className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
            <Sparkles className="h-3 w-3 text-primary" />
            <span>Live Format Preview:</span>
          </div>
          <div className="mt-0.5 truncate font-mono text-xs font-semibold text-primary select-all">
            {liveFormatPreview}
          </div>
        </div>

        {/* Clickable Token Chips */}
        <div>
          <span className="text-[10px] font-medium text-muted-foreground block mb-1.5">
            Click a token to insert into format:
          </span>
          <div className="flex flex-wrap gap-1">
            {CUSTOM_FORMAT_TOKENS.map((item) => (
              <button
                key={item.token}
                type="button"
                onClick={() => handleInsertToken(item.token)}
                title={`${item.description} (${item.token})`}
                className="rounded border border-border bg-background/70 px-1.5 py-0.5 font-mono text-[10px] text-foreground transition-colors hover:border-primary hover:bg-primary/15 hover:text-primary"
              >
                + {item.token}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Quick Naming Format Presets (FR-12) */}
      <div className="space-y-2 border-t border-border/60 pt-3.5">
        <div className="flex items-center gap-1.5 font-semibold text-foreground">
          <SlidersHorizontal className="h-3.5 w-3.5 text-primary" />
          <span>Quick Format Presets</span>
        </div>

        <div
          className="space-y-1.5 pt-0.5"
          role="radiogroup"
          aria-label="Output naming format presets"
        >
          {OUTPUT_PATTERNS.map((preset) => {
            const active = pattern === preset.value;
            return (
              <button
                key={preset.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onChangePattern(preset.value)}
                className={cn(
                  "flex w-full flex-col items-start rounded-lg border px-2.5 py-2 text-left transition-all",
                  active
                    ? "border-primary bg-primary/10 shadow-xs"
                    : "border-border/70 bg-background/50 hover:bg-accent/60"
                )}
              >
                <span className="font-medium text-foreground text-[11px]">
                  {preset.label}
                </span>
                <span className="mt-0.5 font-mono text-[10px] text-primary">
                  {formatEpisodeFilename(
                    sampleSeriesName,
                    sampleSeason,
                    1,
                    ".mkv",
                    preset.value
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Detected Series + Season Group Editor (FR-07, FR-11, Section 5) */}
      <div className="space-y-2 border-t border-border/60 pt-3.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 font-semibold text-foreground">
            <Layers className="h-3.5 w-3.5 text-primary" />
            <span>Detected Series Groups</span>
          </div>
          <Badge variant="secondary" className="text-[10px]">
            {seriesGroups.length}
          </Badge>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Override the{" "}
          <code className="font-mono text-foreground">{"{series}"}</code> title
          for an entire season group.
        </p>

        {seriesGroups.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-3 text-center text-[11px] text-muted-foreground">
            No recognized series groups in current view.
          </div>
        ) : (
          <div className="space-y-2.5 pt-1">
            {seriesGroups.map((group) => {
              const isOverridden =
                group.overrideSeries.trim() !== "" &&
                group.overrideSeries !== group.detectedSeries;
              return (
                <div
                  key={group.groupKey}
                  className="rounded-lg border border-border/80 bg-background/60 p-2.5 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-mono text-[11px] font-semibold text-primary">
                      Season {formatNumberMinWidth2(group.season)}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {group.episodeCount} ep{group.episodeCount === 1 ? "" : "s"}
                    </span>
                  </div>

                  <div className="flex items-center gap-1">
                    <Input
                      value={group.overrideSeries}
                      onChange={(e) =>
                        onChangeGroupSeries(group.groupKey, e.target.value)
                      }
                      aria-label={`Series title for ${group.detectedSeries} Season ${group.season}`}
                      className="h-7 text-xs"
                    />
                    {isOverridden && (
                      <button
                        type="button"
                        onClick={() =>
                          onChangeGroupSeries(
                            group.groupKey,
                            group.detectedSeries
                          )
                        }
                        title="Reset to detected series title"
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        <RotateCcw className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Supported Video Extensions Filter (FR-03) */}
      <div className="space-y-2 border-t border-border/60 pt-3.5 mt-auto">
        <div className="flex items-center gap-1.5 font-semibold text-foreground">
          <Film className="h-3.5 w-3.5 text-primary" />
          <span>Video Extensions</span>
        </div>
        <div className="grid grid-cols-2 gap-1.5 pt-1">
          {DEFAULT_SUPPORTED_EXTENSIONS.map((ext) => {
            const checked = supportedExtensions.includes(ext);
            return (
              <label
                key={ext}
                className="flex items-center gap-1.5 rounded border border-border/60 bg-background/40 px-2 py-1 cursor-pointer hover:bg-accent/40"
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={(c) => handleToggleExt(ext, Boolean(c))}
                />
                <span className="font-mono text-[11px]">{ext}</span>
              </label>
            );
          })}
        </div>
      </div>
    </aside>
  );
};
