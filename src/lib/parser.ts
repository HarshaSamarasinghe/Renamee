export type RecognitionStatus =
  | "ready"
  | "unchanged"
  | "ambiguous"
  | "unrecognized"
  | "duplicate_target"
  | "disk_conflict"
  | "invalid_chars";

export interface ParsedFilename {
  originalName: string;
  seriesName: string | null;
  season: number | null;
  episode: number | null;
  episodeEnd: number | null;
  extension: string;
  removedTags: string[];
  suggestedName: string;
  status: RecognitionStatus;
  reason: string | null;
  patternMatched: string | null;
}

export interface FileScanItem {
  id: string;
  folderPath: string;
  originalName: string;
  fullPath: string;
  sizeBytes: number;
  isVideo: boolean;
  parsed: ParsedFilename;
  selected?: boolean;
  customTargetName?: string;
}

export interface RenameRequestItem {
  originalName: string;
  targetName: string;
}

export interface RenameOperationRecord {
  originalName: string;
  newName: string;
}

export interface RenameBatchRecord {
  batchId: string;
  folderPath: string;
  timestamp: string;
  operations: RenameOperationRecord[];
}

export interface BatchRenameResult {
  success: boolean;
  renamedCount: number;
  batch: RenameBatchRecord | null;
  errors: string[];
}

const STANDARD_SE_RE =
  /^(?<series>.+?)[.\s_\-[\(]+S(?<season>\d{1,2})[\s._\-]*E(?<ep>\d{1,3})(?:(?:[\s._\-]*[-~][\s._\-]*E?|[\s._\-]+E)(?<ep2>\d{1,3}))?(?:[^a-zA-Z0-9]|$)(?<rest>.*)$/i;

const X_FORMAT_RE =
  /^(?<series>.+?)[.\s_\-[\(]+(?<season>\d{1,2})x(?<ep>\d{1,3})(?:[-~](?:(?:\d{1,2}x)?(?<ep2>\d{1,3})))?(?:[^a-zA-Z0-9]|$)(?<rest>.*)$/i;

const SPELLED_SE_RE =
  /^(?<series>.+?)[.\s_\-[\(]+Season[\s._\-]*(?<season>\d{1,2})[\s._\-,]+Episode[\s._\-]*(?<ep>\d{1,3})(?:[\s._\-]*[-~][\s._\-]*(?<ep2>\d{1,3}))?(?:[^a-zA-Z0-9]|$)(?<rest>.*)$/i;

const EP_ONLY_RE =
  /^(?<series>.+?)[.\s_\-[\(]+(?:E|EP|Episode)[\s._\-]*(?<ep>\d{1,3})(?:[^a-zA-Z0-9]|$)(?<rest>.*)$/i;

const COMPACT_NUMERIC_RE =
  /^(?<series>.+?)[.\s_\-]+(?<num>\d{3,4})(?:[^a-zA-Z0-9]|$)(?<rest>.*)$/i;

const LEADING_BRACKET_RE = /^\[(?<tag>[^\]]+)\][\s._\-]*(?<remainder>.+)$/;

const KNOWN_TAG_RE =
  /^(?:480p|540p|720p|1080p|1080i|1440p|2160p|4k|8k|uhd|fhd|hd|sd|x264|x265|h264|h265|hevc|avc|av1|xvid|divx|vp9|10bit|8bit|hdr|hdr10|hdr10plus|dv|dovi|dolby|vision|web-dl|webdl|webrip|web|bluray|blu-ray|bdrip|brrip|remux|hdrip|hdtv|pdtv|dvdrip|dvdscr|cam|ts|tc|aac|aac2|ac3|eac3|ddp|ddp5|dd5|dts|dts-hd|truehd|atmos|flac|mp3|opus|dual|multi|dubbed|subbed|subs|esub|esubs|proper|repack|rerip|internal|limited|extended|uncut|directors|nf|amzn|dsnp|atvp|hmax|hulu|pcok|bbc|itunes|cr)$/i;

const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

export function splitStemAndExtension(filename: string): {
  stem: string;
  extension: string;
} {
  const idx = filename.lastIndexOf(".");
  if (idx > 0 && idx < filename.length - 1) {
    return {
      stem: filename.slice(0, idx),
      extension: filename.slice(idx),
    };
  }
  return { stem: filename, extension: "" };
}

export function sanitizeWindowsComponent(input: string): string {
  return input
    .replace(/[<>:"/\\|?*]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
    .replace(/\.+$/, "");
}

export function validateWindowsFilename(filename: string): string | null {
  if (!filename.trim()) {
    return "Filename cannot be empty";
  }
  if (/[<>:"/\\|?*]/.test(filename)) {
    return 'Contains invalid Windows filename characters (< > : " / \\ | ? *)';
  }
  const { stem } = splitStemAndExtension(filename);
  if (WINDOWS_RESERVED_NAMES.has(stem.toUpperCase())) {
    return `'${stem}' is a reserved Windows system name`;
  }
  return null;
}

function cleanSeriesName(rawSeries: string, removedTags: string[]): string {
  let working = rawSeries.trim();
  while (true) {
    const match = working.match(LEADING_BRACKET_RE);
    if (!match || !match.groups) break;
    if (match.groups.tag) {
      removedTags.push(`[${match.groups.tag}]`);
    }
    working = match.groups.remainder || "";
  }

  const replaced = working.replace(/[._]/g, " ");
  const tokens = replaced
    .split(/\s+/)
    .map((t) => t.replace(/^[-()[\]]+|[-()[\]]+$/g, ""))
    .filter(Boolean);

  while (tokens.length > 0 && KNOWN_TAG_RE.test(tokens[tokens.length - 1])) {
    const popped = tokens.pop()!;
    removedTags.push(popped);
  }

  return sanitizeWindowsComponent(tokens.join(" "));
}

function extractMetadataTags(rest: string, removedTags: string[]): void {
  const cleaned = rest.trim();
  if (!cleaned) return;
  for (const part of cleaned.split(/[._\s[\]()]+/)) {
    const trimmed = part.replace(/^-+|-+$/g, "").trim();
    if (trimmed) {
      removedTags.push(trimmed);
    }
  }
}

export function pad2(num: number): string {
  return num.toString().padStart(2, "0");
}

export function parseFilename(filename: string): ParsedFilename {
  const { stem, extension } = splitStemAndExtension(filename);
  const removedTags: string[] = [];

  const tryMatch = (
    regex: RegExp,
    patternLabel: string
  ): ParsedFilename | null => {
    const match = stem.match(regex);
    if (!match || !match.groups) return null;

    const rawSeries = match.groups.series || "";
    const season = parseInt(match.groups.season || "", 10);
    const episode = parseInt(match.groups.ep || "", 10);
    const episodeEnd = match.groups.ep2
      ? parseInt(match.groups.ep2, 10)
      : null;
    const rest = match.groups.rest || "";

    if (Number.isNaN(season) || Number.isNaN(episode)) return null;

    const seriesName = cleanSeriesName(rawSeries, removedTags);
    extractMetadataTags(rest, removedTags);

    if (!seriesName) return null;

    const epFormatted =
      episodeEnd !== null && !Number.isNaN(episodeEnd) && episodeEnd > episode
        ? `S${pad2(season)}E${pad2(episode)}-E${pad2(episodeEnd)}`
        : `S${pad2(season)}E${pad2(episode)}`;

    const suggestedName = `${seriesName} ${epFormatted}${extension}`;
    const status: RecognitionStatus =
      suggestedName === filename ? "unchanged" : "ready";

    return {
      originalName: filename,
      seriesName,
      season,
      episode,
      episodeEnd:
        episodeEnd !== null && !Number.isNaN(episodeEnd) ? episodeEnd : null,
      extension,
      removedTags,
      suggestedName,
      status,
      reason: null,
      patternMatched: patternLabel,
    };
  };

  const standard = tryMatch(STANDARD_SE_RE, "Standard SxxExx");
  if (standard) return standard;

  const xFormat = tryMatch(X_FORMAT_RE, "NxNN (1x01)");
  if (xFormat) return xFormat;

  const spelled = tryMatch(SPELLED_SE_RE, "Spelled Season/Episode");
  if (spelled) return spelled;

  const epOnly = stem.match(EP_ONLY_RE);
  if (epOnly && epOnly.groups) {
    const rawSeries = epOnly.groups.series || "";
    const episode = parseInt(epOnly.groups.ep || "", 10);
    const rest = epOnly.groups.rest || "";
    if (!Number.isNaN(episode)) {
      const seriesName = cleanSeriesName(rawSeries, removedTags);
      extractMetadataTags(rest, removedTags);
      const suggestedName = seriesName
        ? `${seriesName} S01E${pad2(episode)}${extension}`
        : filename;

      return {
        originalName: filename,
        seriesName: seriesName || null,
        season: null,
        episode,
        episodeEnd: null,
        extension,
        removedTags,
        suggestedName,
        status: "ambiguous",
        reason:
          "Episode number found without explicit Season number (flagged as ambiguous)",
        patternMatched: "Episode-Only (Ambiguous)",
      };
    }
  }

  const compact = stem.match(COMPACT_NUMERIC_RE);
  if (compact && compact.groups) {
    const numStr = compact.groups.num || "";
    const rawSeries = compact.groups.series || "";
    const seriesName = cleanSeriesName(rawSeries, removedTags);
    const isYearOrRes =
      numStr === "720" ||
      numStr === "1080" ||
      numStr === "2160" ||
      (numStr.length === 4 &&
        (numStr.startsWith("19") || numStr.startsWith("20")));

    return {
      originalName: filename,
      seriesName: seriesName || null,
      season: null,
      episode: null,
      episodeEnd: null,
      extension,
      removedTags,
      suggestedName: filename,
      status: "ambiguous",
      reason: isYearOrRes
        ? "Contains year or resolution number without explicit Season/Episode marker"
        : `Contains ambiguous numeric sequence '${numStr}' without explicit S/E or NxNN marker`,
      patternMatched: null,
    };
  }

  return {
    originalName: filename,
    seriesName: null,
    season: null,
    episode: null,
    episodeEnd: null,
    extension,
    removedTags: [],
    suggestedName: filename,
    status: "unrecognized",
    reason: "No recognizable Season/Episode pattern found",
    patternMatched: null,
  };
}

export function evaluateBatchStatuses(
  items: FileScanItem[],
  existingDiskFilesLower?: Set<string>
): FileScanItem[] {
  const targetCounts = new Map<string, number>();
  const batchOriginalsLower = new Set<string>();

  for (const item of items) {
    batchOriginalsLower.add(item.originalName.toLowerCase());
    const effectiveTarget = (
      item.customTargetName ?? item.parsed.suggestedName
    ).trim();
    const isUserEdited =
      item.customTargetName !== undefined &&
      item.customTargetName !== item.parsed.suggestedName;

    if (
      isUserEdited ||
      item.parsed.status === "ready" ||
      item.parsed.status === "duplicate_target" ||
      item.parsed.status === "disk_conflict"
    ) {
      const key = effectiveTarget.toLowerCase();
      targetCounts.set(key, (targetCounts.get(key) || 0) + 1);
    }
  }

  return items.map((item) => {
    const effectiveTarget = (
      item.customTargetName ?? item.parsed.suggestedName
    ).trim();
    const isUserEdited =
      item.customTargetName !== undefined &&
      item.customTargetName !== item.parsed.suggestedName;

    const invalidErr = validateWindowsFilename(effectiveTarget);
    if (invalidErr) {
      return {
        ...item,
        parsed: {
          ...item.parsed,
          status: "invalid_chars",
          reason: invalidErr,
        },
      };
    }

    if (
      !isUserEdited &&
      (item.parsed.status === "ambiguous" ||
        item.parsed.status === "unrecognized")
    ) {
      return item;
    }

    const targetLower = effectiveTarget.toLowerCase();
    const origLower = item.originalName.toLowerCase();

    if ((targetCounts.get(targetLower) || 0) > 1) {
      return {
        ...item,
        parsed: {
          ...item.parsed,
          status: "duplicate_target",
          reason: `Multiple files in this batch would be renamed to '${effectiveTarget}'`,
        },
      };
    }

    if (
      targetLower !== origLower &&
      existingDiskFilesLower?.has(targetLower) &&
      !batchOriginalsLower.has(targetLower)
    ) {
      return {
        ...item,
        parsed: {
          ...item.parsed,
          status: "disk_conflict",
          reason: `A file named '${effectiveTarget}' already exists in the folder`,
        },
      };
    }

    if (effectiveTarget === item.originalName) {
      return {
        ...item,
        parsed: {
          ...item.parsed,
          status: "unchanged",
          reason: null,
        },
      };
    }

    return {
      ...item,
      parsed: {
        ...item.parsed,
        status: "ready",
        reason: null,
      },
    };
  });
}
