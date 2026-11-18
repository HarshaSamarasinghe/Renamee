// ============================================================================
// PHASE 1: PURE FILENAME RECOGNITION & FORMATTING ENGINE (TypeScript)
// Matches Section 5 & Section 9 (T01..T15) of Implementation Plan
// ============================================================================

import {
  FileEntry,
  OutputPatternPreset,
  ParsedEpisode,
  PreviewOverrides,
} from "./types";

export const DEFAULT_PATTERN: OutputPatternPreset =
  "{series} S{season:02}E{episode:02}{extension}";

export const OUTPUT_PATTERNS: {
  label: string;
  value: OutputPatternPreset;
  example: string;
}[] = [
  {
    label: "Space Separated (Default)",
    value: "{series} S{season:02}E{episode:02}{extension}",
    example: "Trigger S01E01.mkv",
  },
  {
    label: "Dot Separated",
    value: "{series.dots}.S{season:02}E{episode:02}{extension}",
    example: "Trigger.S01E01.mkv",
  },
  {
    label: "Dash Separated",
    value: "{series} - S{season:02}E{episode:02}{extension}",
    example: "Trigger - S01E01.mkv",
  },
  {
    label: "1x01 Format",
    value: "{series} {season}x{episode:02}{extension}",
    example: "Trigger 1x01.mkv",
  },
  {
    label: "Season & Episode Spelled",
    value: "{series} - Season {season} Episode {episode:02}{extension}",
    example: "Trigger - Season 1 Episode 01.mkv",
  },
];

export const CUSTOM_FORMAT_TOKENS: {
  token: string;
  label: string;
  description: string;
}[] = [
  { token: "{series}", label: "Series", description: "Series title (spaces)" },
  {
    token: "{series.dots}",
    label: "Series.Dots",
    description: "Series title with dots",
  },
  {
    token: "{series.underscores}",
    label: "Series_Under",
    description: "Series title with underscores",
  },
  {
    token: "S{season:02}",
    label: "S01",
    description: "2-digit season with S prefix",
  },
  {
    token: "E{episode:02}",
    label: "E01",
    description: "2-digit episode with E prefix",
  },
  {
    token: "{season:02}",
    label: "01 (Season)",
    description: "2-digit padded season number",
  },
  {
    token: "{season}",
    label: "1 (Season)",
    description: "Unpadded season number",
  },
  {
    token: "{episode:02}",
    label: "01 (Ep)",
    description: "2-digit padded episode number",
  },
  {
    token: "{episode:03}",
    label: "001 (Ep)",
    description: "3-digit padded episode number",
  },
  {
    token: "{episode}",
    label: "1 (Ep)",
    description: "Unpadded episode number",
  },
];

/**
 * Step A: Split final extension using last-dot logic, with special handling
 * for dotfiles (e.g. ".gitignore") and empty stems. Preserves exact extension casing.
 */
export function splitStemAndExtension(filename: string): {
  stem: string;
  extension: string;
} {
  if (!filename) {
    return { stem: "", extension: "" };
  }
  const lastDot = filename.lastIndexOf(".");
  // Dot at index 0 is a dotfile (hidden file), not an extension on a stem
  // Dot at the very end ("file.") is a trailing dot, not a valid extension
  if (lastDot <= 0 || lastDot === filename.length - 1) {
    return { stem: filename, extension: "" };
  }
  return {
    stem: filename.slice(0, lastDot),
    extension: filename.slice(lastDot),
  };
}

interface CandidateTokenMatch {
  syntax: "SxEy" | "NxM";
  index: number;
  fullMatch: string;
  seasonStr: string;
  episodeStr: string;
}

// Bounded SxxExx token:
// Matches S01E01, s1e2, S01.E03, S01_E03, S01-E03
// Requires left boundary (start of string or separator) and right boundary (end of string or non-alphanumeric)
const SXEY_GLOBAL_RE =
  /(?:^|(?<=[.\s_\-[\(]))[Ss](\d{1,2})[\s._\-]*[Ee](\d{1,4})(?=$|[^a-zA-Z0-9])/g;

// Multi-episode contiguous token detector like S01E01E02 or S01E01-E02 (flagged for explicit review in MVP per Plan Section 3 & 5)
const MULTI_EP_RE =
  /(?:^|(?<=[.\s_\-[\(]))[Ss]\d{1,2}[\s._\-]*[Ee]\d{1,4}[\s._\-]*(?:[-~][\s._\-]*[Ee]?|[Ee])\d{1,4}(?=$|[^a-zA-Z0-9])/;

// Bounded NxM token:
// Matches 1x03, 01x12
const NXM_GLOBAL_RE =
  /(?:^|(?<=[.\s_\-[\(]))(\d{1,2})[xX](\d{1,4})(?=$|[^a-zA-Z0-9])/g;

/**
 * Step D: Normalize title separators ('.' and '_') to spaces, collapse whitespace,
 * and trim trailing separator punctuation (`-`, `:`, spaces) without stripping
 * real title words (like "WEB").
 */
export function normalizeSeriesTitle(rawPrefix: string): string {
  const withSpaces = rawPrefix.replace(/[._]+/g, " ");
  const trimmedSeparators = withSpaces
    .replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return trimmedSeparators;
}

/**
 * Formats season and episode numbers with minimum width of 2 digits,
 * never truncating episode numbers >= 100 (e.g. E107 -> "107", E3 -> "03").
 */
export function formatNumberMinWidth2(num: number): string {
  return num.toString().padStart(2, "0");
}

/**
 * Builds the formatted filename from a ParsedEpisode and any preset or custom template string.
 * Supports tokens:
 *  - {series}, {series.dots}, {series.underscores}
 *  - {season}, {season:02}, {season:03}
 *  - {episode}, {episode:02}, {episode:03}
 *  - {extension}, {ext}
 * Automatically appends the original extension if not already present in the template.
 */
export function formatEpisodeFilename(
  seriesTitle: string,
  season: number,
  episode: number,
  extension: string,
  pattern: OutputPatternPreset = DEFAULT_PATTERN
): string {
  const cleanSeries = seriesTitle.trim();
  const seriesDots = cleanSeries.replace(/\s+/g, ".");
  const seriesUnderscores = cleanSeries.replace(/\s+/g, "_");
  const sPad2 = formatNumberMinWidth2(season);
  const sPad3 = season.toString().padStart(3, "0");
  const ePad2 = formatNumberMinWidth2(episode);
  const ePad3 = episode.toString().padStart(3, "0");

  const activePattern = pattern.trim() || DEFAULT_PATTERN;

  // Backwards compatibility for legacy "{series}.S{season:02}E{episode:02}{extension}" preset
  if (activePattern === "{series}.S{season:02}E{episode:02}{extension}") {
    return `${seriesDots}.S${sPad2}E${ePad2}${extension}`;
  }

  const hasExtToken = /\{(?:extension|ext)\}/i.test(activePattern);

  let result = activePattern
    .replace(/\{series\.dots\}/gi, seriesDots)
    .replace(/\{series\.underscores\}/gi, seriesUnderscores)
    .replace(/\{series\}/gi, cleanSeries)
    .replace(/\{season:03\}/gi, sPad3)
    .replace(/\{season:02\}|\{s00\}/gi, sPad2)
    .replace(/\{season\}|\{s\}/gi, season.toString())
    .replace(/\{episode:03\}|\{e000\}/gi, ePad3)
    .replace(/\{episode:02\}|\{e00\}/gi, ePad2)
    .replace(/\{episode\}|\{e\}/gi, episode.toString())
    .replace(/\{(?:extension|ext)\}/gi, extension);

  if (
    !hasExtToken &&
    extension &&
    !result.toLowerCase().endsWith(extension.toLowerCase())
  ) {
    result = `${result}${extension}`;
  }

  return result;
}

export interface ParseAnalysis {
  stem: string;
  extension: string;
  parsed: ParsedEpisode | null;
  proposedName: string | null;
  needsReview: boolean;
  issues: string[];
}

/**
 * Pure deterministic filename parser following Section 5 of the Implementation Plan.
 * - Extracts episode number strictly from the filename itself.
 * - Flags multiple conflicting episode tokens (e.g. Show.S01E01.S02E05.mkv) as Needs Review.
 * - Flags leading group brackets (e.g. "[Group] My Show - S01E07.mkv") as Needs Review if present.
 * - Does not strip real title words before the episode token.
 * - Does not mistake 4-digit release years (2025) or resolutions (720p/1080p) for episodes.
 */
export function analyzeFilename(
  originalName: string,
  pattern: OutputPatternPreset = DEFAULT_PATTERN
): ParseAnalysis {
  const trimmedName = originalName.trim();
  if (!trimmedName) {
    return {
      stem: "",
      extension: "",
      parsed: null,
      proposedName: null,
      needsReview: true,
      issues: ["Filename is empty"],
    };
  }

  const { stem, extension } = splitStemAndExtension(trimmedName);
  if (!stem || trimmedName.startsWith(".")) {
    return {
      stem,
      extension,
      parsed: null,
      proposedName: null,
      needsReview: true,
      issues: ["Hidden dotfile or missing filename stem"],
    };
  }

  if (!extension) {
    return {
      stem,
      extension,
      parsed: null,
      proposedName: null,
      needsReview: true,
      issues: ["Missing file extension"],
    };
  }

  // Check for multi-episode contiguous ranges like S01E01E02 (requires review per MVP rules)
  if (MULTI_EP_RE.test(stem)) {
    return {
      stem,
      extension,
      parsed: null,
      proposedName: null,
      needsReview: true,
      issues: [
        "Multi-episode token detected; flagged for manual review",
      ],
    };
  }

  // Collect all candidate matches across SxEy and NxM
  const candidates: CandidateTokenMatch[] = [];

  for (const match of stem.matchAll(SXEY_GLOBAL_RE)) {
    if (match.index !== undefined) {
      candidates.push({
        syntax: "SxEy",
        index: match.index,
        fullMatch: match[0],
        seasonStr: match[1],
        episodeStr: match[2],
      });
    }
  }

  for (const match of stem.matchAll(NXM_GLOBAL_RE)) {
    if (match.index !== undefined) {
      candidates.push({
        syntax: "NxM",
        index: match.index,
        fullMatch: match[0],
        seasonStr: match[1],
        episodeStr: match[2],
      });
    }
  }

  if (candidates.length === 0) {
    return {
      stem,
      extension,
      parsed: null,
      proposedName: null,
      needsReview: true,
      issues: [
        "No explicit Season/Episode token (SxxExx or NxNN) found",
      ],
    };
  }

  // Rule: If multiple conflicting episode patterns are present (e.g. Show.S01E01.S02E05.mkv), mark Needs Review
  if (candidates.length > 1) {
    return {
      stem,
      extension,
      parsed: null,
      proposedName: null,
      needsReview: true,
      issues: [
        `Ambiguous filename: multiple episode tokens found (${candidates
          .map((c) => c.fullMatch)
          .join(", ")})`,
      ],
    };
  }

  const chosen = candidates[0];
  const rawTitlePrefix = stem.slice(0, chosen.index);

  // Check if the prefix starts with an unhandled "[Group]" tag (Section 5: flag review if group prefix present)
  if (/^\s*\[[^\]]+\]/.test(rawTitlePrefix)) {
    return {
      stem,
      extension,
      parsed: null,
      proposedName: null,
      needsReview: true,
      issues: [
        "Contains leading release group bracket prefix; please review series title",
      ],
    };
  }

  const normalizedSeries = normalizeSeriesTitle(rawTitlePrefix);
  if (!normalizedSeries) {
    return {
      stem,
      extension,
      parsed: null,
      proposedName: null,
      needsReview: true,
      issues: ["Missing series title before episode token"],
    };
  }

  const season = parseInt(chosen.seasonStr, 10);
  const episode = parseInt(chosen.episodeStr, 10);

  if (Number.isNaN(season) || Number.isNaN(episode)) {
    return {
      stem,
      extension,
      parsed: null,
      proposedName: null,
      needsReview: true,
      issues: ["Failed to parse numeric season or episode value"],
    };
  }

  const parsed: ParsedEpisode = {
    series: normalizedSeries,
    season,
    episode,
    seasonDigits: chosen.seasonStr.length,
    episodeDigits: chosen.episodeStr.length,
    matchedSyntax: chosen.syntax,
    confidence: chosen.syntax === "SxEy" ? "high" : "medium",
    explanation: `Matched ${chosen.syntax} token '${chosen.fullMatch}' -> Series '${normalizedSeries}', Season ${season}, Episode ${episode}`,
  };

  const proposedName = formatEpisodeFilename(
    normalizedSeries,
    season,
    episode,
    extension,
    pattern
  );

  return {
    stem,
    extension,
    parsed,
    proposedName,
    needsReview: false,
    issues: [],
  };
}

/**
 * Computes a normalized group key for grouping files by (normalized series lowercase + season)
 * so users can override the series title for an entire season/show without altering episode numbers.
 */
export function getSeriesSeasonGroupKey(parsed: ParsedEpisode): string {
  return `${parsed.series.toLowerCase()}::s${parsed.season}`;
}

/**
 * Applies user overrides (group series title overrides, output pattern preset, individual row edits,
 * and exclusions) to a list of FileEntry items without mutating episode numbers.
 */
export function applyPreviewOverrides(
  entries: FileEntry[],
  overrides: PreviewOverrides
): FileEntry[] {
  const excludedSet = new Set(overrides.excludedIds);

  return entries.map((entry) => {
    const isSelected = !excludedSet.has(entry.id);
    const manualRowName = overrides.manualRowNames[entry.id];

    // Individual row edit has highest precedence (FR-11)
    if (manualRowName !== undefined && manualRowName.trim() !== "") {
      const trimmedManual = manualRowName.trim();
      // Preserve exact original extension if user omitted it
      const finalManual =
        entry.extension &&
        !trimmedManual.endsWith(entry.extension)
          ? `${splitStemAndExtension(trimmedManual).stem}${entry.extension}`
          : trimmedManual;

      return {
        ...entry,
        selected: isSelected,
        manualEditedName: finalManual,
        proposedName: finalManual,
        status: isSelected ? "ready" : "skipped",
        issues: [],
      };
    }

    const analysis = analyzeFilename(entry.originalName, overrides.pattern);
    if (!analysis.parsed || analysis.needsReview) {
      return {
        ...entry,
        stem: analysis.stem,
        extension: analysis.extension,
        parsed: null,
        proposedName: null,
        selected: false,
        status: "needs_review",
        issues: analysis.issues,
      };
    }

    const groupKey = getSeriesSeasonGroupKey(analysis.parsed);
    const groupSeriesOverride = overrides.seriesOverrides[groupKey]?.trim();
    const effectiveSeries =
      groupSeriesOverride && groupSeriesOverride.length > 0
        ? groupSeriesOverride
        : analysis.parsed.series;

    const proposedName = formatEpisodeFilename(
      effectiveSeries,
      analysis.parsed.season,
      analysis.parsed.episode,
      analysis.extension,
      overrides.pattern
    );

    return {
      ...entry,
      stem: analysis.stem,
      extension: analysis.extension,
      parsed: {
        ...analysis.parsed,
        series: effectiveSeries,
      },
      proposedName,
      selected: isSelected,
      status: isSelected ? "ready" : "skipped",
      issues: [],
    };
  });
}
