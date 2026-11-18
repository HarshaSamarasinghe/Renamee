// ============================================================================
// PHASE 3 & 4: LIVE PREVIEW VALIDATION (UI Layer; Rust remains authoritative)
// Matches FR-14..FR-18 & Test Matrix T16..T27 of Implementation Plan
// ============================================================================

import { splitStemAndExtension } from "./format";
import { FileEntry } from "./types";

const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
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

const MAX_WINDOWS_FILENAME_LENGTH = 255;

/**
 * Validates a proposed Windows basename (FR-17, FR-18, T21, T22, T26, T40).
 * Rejects path separators, path traversal (".."), illegal characters, reserved DOS names,
 * trailing dots or spaces, empty stems, and excessive lengths.
 */
export function validateProposedBasename(
  proposedName: string,
  expectedExtension: string
): string[] {
  const errors: string[] = [];

  if (!proposedName || proposedName.trim().length === 0) {
    errors.push("Proposed filename cannot be empty");
    return errors;
  }

  // FR-18 & T26: Reject path separators and traversal in a proposed basename
  if (
    proposedName.includes("/") ||
    proposedName.includes("\\") ||
    proposedName.includes("..")
  ) {
    errors.push(
      "Path separators (/ or \\) and traversal (..) are not allowed in filenames"
    );
  }

  // FR-17 & T22: Check trailing space or trailing dot on raw string
  if (proposedName.endsWith(" ") || proposedName.endsWith(".")) {
    errors.push("Windows filenames cannot end with a trailing space or period");
  }

  // FR-17 & T21: Illegal Windows characters (< > : " / \ | ? * and control chars 0..31)
  if (/[<>:"/\\|?*\x00-\x1F]/.test(proposedName)) {
    errors.push(
      'Contains invalid Windows filename characters (< > : " / \\ | ? *)'
    );
  }

  // T40: Max filename length
  if (proposedName.length > MAX_WINDOWS_FILENAME_LENGTH) {
    errors.push(
      `Filename exceeds maximum length of ${MAX_WINDOWS_FILENAME_LENGTH} characters`
    );
  }

  const { stem, extension } = splitStemAndExtension(proposedName);
  if (!stem || stem.trim().length === 0) {
    errors.push("Filename stem before extension cannot be empty");
  } else {
    // Check reserved device names (both bare stem and stem before first dot)
    const bareDevice = stem.split(".")[0].trim().toUpperCase();
    if (WINDOWS_RESERVED_DEVICE_NAMES.has(bareDevice)) {
      errors.push(`'${stem}' is a reserved Windows device name`);
    }
  }

  // Mandatory Invariant: Preserve exact extension
  if (expectedExtension && extension !== expectedExtension) {
    errors.push(
      `Extension must remain '${expectedExtension}' (found '${extension || "none"}')`
    );
  }

  return errors;
}

/**
 * Evaluates batch-wide conflicts (FR-15, FR-16, T16, T17, T18, T19, T20, T27).
 * - Uses Windows case-insensitive destination key (`directory.toLowerCase() + "\\" + proposedName.toLowerCase()`).
 * - Detects duplicate destination names within the batch.
 * - Detects collisions with existing unselected/untouched files in the same directory.
 * - Allows case-only renames of the same file (T19) and two-file swaps (T20) because the staged renamer handles them.
 * - Marks exact no-op renames (`proposedName === originalName`) as `skipped` (Unchanged, T18).
 */
export function validatePreviewBatch(
  entries: FileEntry[],
  unselectedDiskFilesByDirLower?: Map<string, Set<string>>
): FileEntry[] {
  // Count case-insensitive destination keys for all candidate rows that have a proposedName and are not excluded
  const destinationCounts = new Map<string, number>();
  const activeSourceKeys = new Set<string>();

  for (const entry of entries) {
    const dirLower = entry.directory.toLowerCase();
    const origKey = `${dirLower}\\${entry.originalName.toLowerCase()}`;

    if (entry.selected && entry.proposedName) {
      const destKey = `${dirLower}\\${entry.proposedName.toLowerCase()}`;
      destinationCounts.set(destKey, (destinationCounts.get(destKey) ?? 0) + 1);
      if (entry.proposedName !== entry.originalName) {
        activeSourceKeys.add(origKey);
      }
    }
  }

  // Also track unselected files from the scanned folder as existing disk files that cannot be overwritten
  const untouchedBatchKeys = new Set<string>();
  for (const entry of entries) {
    const dirLower = entry.directory.toLowerCase();
    const origKey = `${dirLower}\\${entry.originalName.toLowerCase()}`;
    const isMovingAway =
      entry.selected &&
      entry.proposedName &&
      entry.proposedName.toLowerCase() !== entry.originalName.toLowerCase();
    if (!isMovingAway) {
      untouchedBatchKeys.add(origKey);
    }
  }

  return entries.map((entry) => {
    // Unrecognized / ambiguous entries without a manual edit remain in needs_review
    if (!entry.proposedName) {
      return {
        ...entry,
        selected: false,
        status: "needs_review",
      };
    }

    // Validate Windows filename syntax & extension preservation
    const basenameErrors = validateProposedBasename(
      entry.proposedName,
      entry.extension
    );
    if (basenameErrors.length > 0) {
      return {
        ...entry,
        status: "conflict",
        issues: basenameErrors,
      };
    }

    // User explicitly deselected/excluded this row
    if (!entry.selected) {
      return {
        ...entry,
        status: "skipped",
        issues: ["Excluded by user"],
      };
    }

    // T18: Exact no-op rename (case-sensitive match with originalName)
    if (entry.proposedName === entry.originalName) {
      return {
        ...entry,
        selected: false,
        status: "skipped",
        issues: ["Filename is already clean (unchanged)"],
      };
    }

    const dirLower = entry.directory.toLowerCase();
    const origKey = `${dirLower}\\${entry.originalName.toLowerCase()}`;
    const destKey = `${dirLower}\\${entry.proposedName.toLowerCase()}`;

    // T16: Duplicate destination within batch
    if ((destinationCounts.get(destKey) ?? 0) > 1) {
      return {
        ...entry,
        status: "conflict",
        issues: [
          `Duplicate destination: multiple files in this folder would be renamed to '${entry.proposedName}'`,
        ],
      };
    }

    // T17: Collision with an untouched file in the folder (unless it's a case-only rename of self)
    const isCaseOnlySelfRename = origKey === destKey;
    if (!isCaseOnlySelfRename) {
      const collidesWithUntouchedScannedFile = untouchedBatchKeys.has(destKey);
      const externalSet = unselectedDiskFilesByDirLower?.get(dirLower);
      const collidesWithExternalDiskFile =
        externalSet?.has(entry.proposedName.toLowerCase()) &&
        !activeSourceKeys.has(destKey);

      if (collidesWithUntouchedScannedFile || collidesWithExternalDiskFile) {
        return {
          ...entry,
          status: "conflict",
          issues: [
            `Conflict: a file named '${entry.proposedName}' already exists in this folder`,
          ],
        };
      }
    }

    return {
      ...entry,
      status: "ready",
      issues: [],
    };
  });
}
