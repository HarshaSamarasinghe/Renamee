// ============================================================================
// PHASE 1: TABLE-DRIVEN UNIT TESTS (T01..T15 from Section 9 of Plan)
// ============================================================================

import { describe, expect, it } from "vitest";
import {
  analyzeFilename,
  applyPreviewOverrides,
  DEFAULT_PATTERN,
  formatEpisodeFilename,
  getSeriesSeasonGroupKey,
  splitStemAndExtension,
} from "../features/renamer/format";
import {
  buildFileEntryFromRaw,
  executeRenamePlanCommand,
  scanFolderCommand,
  sortEntriesForDisplay,
  undoBatchCommand,
  validateRenamePlanCommand,
} from "../features/renamer/api";
import {
  validatePreviewBatch,
  validateProposedBasename,
} from "../features/renamer/validation";

describe("Phase 1 - Filename Recognition Engine (Test Matrix T01..T15)", () => {
  it("T01..T07: recognizes standard S01E01, S01_E03, S01.E10, S1E2, 1x03, multi-word titles, and 3-digit episodes", () => {
    const table: {
      id: string;
      input: string;
      expectedName: string;
      expectedSeries: string;
      expectedSeason: number;
      expectedEpisode: number;
      expectedExt: string;
    }[] = [
      {
        id: "T01",
        input: "Trigger.S01E01.x265.720p.WEB-EDITH.mkv",
        expectedName: "Trigger S01E01.mkv",
        expectedSeries: "Trigger",
        expectedSeason: 1,
        expectedEpisode: 1,
        expectedExt: ".mkv",
      },
      {
        id: "T02",
        input: "Trigger.S01E02.x265.720p.jshbsdkh-webrip.mkv",
        expectedName: "Trigger S01E02.mkv",
        expectedSeries: "Trigger",
        expectedSeason: 1,
        expectedEpisode: 2,
        expectedExt: ".mkv",
      },
      {
        id: "T02b",
        input: "Trigger.S01_E03.x265.720p.wefi-helman.mkv",
        expectedName: "Trigger S01E03.mkv",
        expectedSeries: "Trigger",
        expectedSeason: 1,
        expectedEpisode: 3,
        expectedExt: ".mkv",
      },
      {
        id: "T03",
        input: "Trigger.S01.E10.x265.720p-WEB-randomvideo.mkv",
        expectedName: "Trigger S01E10.mkv",
        expectedSeries: "Trigger",
        expectedSeason: 1,
        expectedEpisode: 10,
        expectedExt: ".mkv",
      },
      {
        id: "T04",
        input: "Trigger.S1E2.1080p.mp4",
        expectedName: "Trigger S01E02.mp4",
        expectedSeries: "Trigger",
        expectedSeason: 1,
        expectedEpisode: 2,
        expectedExt: ".mp4",
      },
      {
        id: "T05",
        input: "Trigger.1x03.HDTV.avi",
        expectedName: "Trigger S01E03.avi",
        expectedSeries: "Trigger",
        expectedSeason: 1,
        expectedEpisode: 3,
        expectedExt: ".avi",
      },
      {
        id: "T06",
        input: "My.Show.Name.S03E12.mkv",
        expectedName: "My Show Name S03E12.mkv",
        expectedSeries: "My Show Name",
        expectedSeason: 3,
        expectedEpisode: 12,
        expectedExt: ".mkv",
      },
      {
        id: "T07",
        input: "My.Show.S02E107.WEBRip.MKV",
        expectedName: "My Show S02E107.MKV",
        expectedSeries: "My Show",
        expectedSeason: 2,
        expectedEpisode: 107,
        expectedExt: ".MKV",
      },
    ];

    for (const row of table) {
      const res = analyzeFilename(row.input);
      expect(res.needsReview, `${row.id} should not need review`).toBe(false);
      expect(res.proposedName, `${row.id} proposedName`).toBe(row.expectedName);
      expect(res.parsed?.series, `${row.id} series`).toBe(row.expectedSeries);
      expect(res.parsed?.season, `${row.id} season`).toBe(row.expectedSeason);
      expect(res.parsed?.episode, `${row.id} episode`).toBe(
        row.expectedEpisode
      );
      expect(res.extension, `${row.id} exact extension casing`).toBe(
        row.expectedExt
      );
    }
  });

  it("T08 & T15: flags filenames without episode tokens or containing only year/resolution tokens as Needs Review", () => {
    const t08 = analyzeFilename("filename_without_episode.mkv");
    expect(t08.needsReview).toBe(true);
    expect(t08.proposedName).toBeNull();

    const t15 = analyzeFilename("Dune.Part.Two.2024.1080p.WEB-DL.x265.mkv");
    expect(t15.needsReview).toBe(true);
    expect(t15.proposedName).toBeNull();

    const looseNumber = analyzeFilename("random-video-123.mkv");
    expect(looseNumber.needsReview).toBe(true);
    expect(looseNumber.proposedName).toBeNull();
  });

  it("T09: flags multiple conflicting episode tokens (Show.S01E01.S02E05.mkv) as Needs Review", () => {
    const t09 = analyzeFilename("Show.S01E01.S02E05.mkv");
    expect(t09.needsReview).toBe(true);
    expect(t09.proposedName).toBeNull();
    expect(t09.issues[0]).toMatch(/multiple episode tokens/i);
  });

  it("T10, T11, T12: preserves missing episode gaps, distinct seasons, and independent series without sort-order renumbering", () => {
    const batch = [
      "Show.S01E01.mkv",
      "Show.S01E03.mkv",
      "Show.S02E01.mkv",
      "Other.Show.S01E01.mkv",
    ].map((f) => analyzeFilename(f));

    expect(batch[0].proposedName).toBe("Show S01E01.mkv");
    expect(batch[1].proposedName).toBe("Show S01E03.mkv");
    expect(batch[2].proposedName).toBe("Show S02E01.mkv");
    expect(batch[3].proposedName).toBe("Other Show S01E01.mkv");
  });

  it("T13: preserves Unicode / Asian series titles and does not strip real title words like WEB", () => {
    const unicodeRes = analyzeFilename("進撃の巨人.S04E28.1080p.WEB-DL.mkv");
    expect(unicodeRes.needsReview).toBe(false);
    expect(unicodeRes.proposedName).toBe("進撃の巨人 S04E28.mkv");

    const webWordInTitle = analyzeFilename("Charlotte's.Web.S01E02.720p.mkv");
    expect(webWordInTitle.needsReview).toBe(false);
    expect(webWordInTitle.proposedName).toBe("Charlotte's Web S01E02.mkv");
  });

  it("T14: handles empty name, hidden dotfile, and malformed extensions safely", () => {
    expect(analyzeFilename("").needsReview).toBe(true);
    expect(analyzeFilename(".gitignore").needsReview).toBe(true);
    expect(analyzeFilename("no_extension_file").needsReview).toBe(true);
    expect(splitStemAndExtension(".nomedia")).toEqual({
      stem: ".nomedia",
      extension: "",
    });
  });

  it("FR-12: supports all three output formatting presets while preserving extension casing", () => {
    expect(
      formatEpisodeFilename(
        "Trigger",
        1,
        10,
        ".MKV",
        "{series} S{season:02}E{episode:02}{extension}"
      )
    ).toBe("Trigger S01E10.MKV");

    expect(
      formatEpisodeFilename(
        "Trigger",
        1,
        10,
        ".MKV",
        "{series}.S{season:02}E{episode:02}{extension}"
      )
    ).toBe("Trigger.S01E10.MKV");

    expect(
      formatEpisodeFilename(
        "Trigger",
        1,
        10,
        ".MKV",
        "{series} - S{season:02}E{episode:02}{extension}"
      )
    ).toBe("Trigger - S01E10.MKV");

    // Custom user-defined format templates with tokens & auto-extension preservation
    expect(
      formatEpisodeFilename(
        "My Show",
        2,
        5,
        ".mkv",
        "[{series.dots}] Season {season} - Ep {episode:03}"
      )
    ).toBe("[My.Show] Season 2 - Ep 005.mkv");

    expect(
      formatEpisodeFilename(
        "My Show",
        1,
        9,
        ".mp4",
        "{series.underscores}_{season}x{episode:02}{ext}"
      )
    ).toBe("My_Show_1x09.mp4");
  });

  it("Phase 2: scans folder non-recursively and recursively, and sorts for display without altering episode numbers", async () => {
    const folder = "C:\\Users\\User\\Videos\\Trigger_Sample_Sandbox";
    const nonRec = await scanFolderCommand(folder, false);
    const rec = await scanFolderCommand(folder, true);

    expect(rec.entries.length).toBeGreaterThan(nonRec.entries.length);

    // Display sort descending by originalName must NEVER change parsed episode numbers
    const sortedDesc = sortEntriesForDisplay(
      nonRec.entries,
      "originalName",
      "desc"
    );
    const ep10 = sortedDesc.find((e) =>
      e.originalName.includes("Trigger.S01.E10")
    );
    const ep01 = sortedDesc.find((e) =>
      e.originalName.includes("Trigger.S01E01")
    );
    expect(ep10?.parsed?.episode).toBe(10);
    expect(ep10?.proposedName).toBe("Trigger S01E10.mkv");
    expect(ep01?.parsed?.episode).toBe(1);
    expect(ep01?.proposedName).toBe("Trigger S01E01.mkv");
  });

  it("Phase 2 (FR-11): group series override updates only the series title and row manual edit takes precedence", () => {
    const entries = [
      buildFileEntryFromRaw({
        id: "row-1",
        name: "Trigger.S01E01.x265.720p.WEB-EDITH.mkv",
        directory: "C:\\Videos",
        sizeBytes: 1000,
        modifiedAt: 100,
      }),
      buildFileEntryFromRaw({
        id: "row-2",
        name: "Trigger.S01.E10.x265.720p-WEB-randomvideo.mkv",
        directory: "C:\\Videos",
        sizeBytes: 1000,
        modifiedAt: 200,
      }),
    ];

    const groupKey = getSeriesSeasonGroupKey(entries[0].parsed!);
    const updated = applyPreviewOverrides(entries, {
      pattern: DEFAULT_PATTERN,
      seriesOverrides: { [groupKey]: "Trigger (2025)" },
      manualRowNames: { "row-2": "Trigger Special Finale" },
      excludedIds: [],
    });

    expect(updated[0].proposedName).toBe("Trigger (2025) S01E01.mkv");
    // Row 2 manual edit takes precedence and automatically preserves the .mkv extension
    expect(updated[1].proposedName).toBe("Trigger Special Finale.mkv");
  });

  it("Phase 3 & 4 Validation (T16..T22, T26, T27, T40): detects duplicate targets, untouched collisions, case-only renames, swaps, and invalid Windows names", () => {
    // T16: Two files producing the same destination -> Conflict
    const dup1 = buildFileEntryFromRaw({
      id: "d1",
      name: "Trigger.S01E01.720p.mkv",
      directory: "C:\\Videos",
      sizeBytes: 100,
      modifiedAt: 1,
    });
    const dup2 = buildFileEntryFromRaw({
      id: "d2",
      name: "Trigger.S01E01.1080p.mkv",
      directory: "C:\\Videos",
      sizeBytes: 200,
      modifiedAt: 2,
    });
    const dupValidated = validatePreviewBatch([dup1, dup2]);
    expect(dupValidated[0].status).toBe("conflict");
    expect(dupValidated[1].status).toBe("conflict");

    // T17: Existing unrelated / unselected target filename in same folder -> Conflict
    const existingClean = buildFileEntryFromRaw({
      id: "e1",
      name: "Trigger S01E02.mkv",
      directory: "C:\\Videos",
      sizeBytes: 100,
      modifiedAt: 1,
    });
    const incomingRelease = buildFileEntryFromRaw({
      id: "e2",
      name: "Trigger.S01E02.1080p.mkv",
      directory: "C:\\Videos",
      sizeBytes: 200,
      modifiedAt: 2,
    });
    const collisionValidated = validatePreviewBatch([
      existingClean,
      incomingRelease,
    ]);
    // existingClean is exact no-op (T18 -> skipped), incomingRelease collides with existingClean -> conflict
    expect(collisionValidated[0].status).toBe("skipped");
    expect(collisionValidated[1].status).toBe("conflict");

    // T19: Case-only rename of self -> Ready (not a self-conflict)
    const caseOnly = buildFileEntryFromRaw({
      id: "c1",
      name: "trigger.s01e01.mkv",
      directory: "C:\\Videos",
      sizeBytes: 100,
      modifiedAt: 1,
    });
    caseOnly.proposedName = "Trigger.S01E01.mkv";
    const caseValidated = validatePreviewBatch([caseOnly]);
    expect(caseValidated[0].status).toBe("ready");

    // T20: Two-file swap A -> B and B -> A -> Ready (staged renamer handles swaps)
    const swapA = buildFileEntryFromRaw({
      id: "sa",
      name: "Trigger S01E01.mkv",
      directory: "C:\\Videos",
      sizeBytes: 100,
      modifiedAt: 1,
    });
    swapA.proposedName = "Trigger S01E02.mkv";
    swapA.selected = true;
    const swapB = buildFileEntryFromRaw({
      id: "sb",
      name: "Trigger S01E02.mkv",
      directory: "C:\\Videos",
      sizeBytes: 100,
      modifiedAt: 2,
    });
    swapB.proposedName = "Trigger S01E01.mkv";
    swapB.selected = true;
    const swapValidated = validatePreviewBatch([swapA, swapB]);
    expect(swapValidated[0].status).toBe("ready");
    expect(swapValidated[1].status).toBe("ready");

    // T21, T22, T26, T40: Invalid chars, reserved names, trailing dot/space, path traversal, and length > 255
    expect(validateProposedBasename("CON.mkv", ".mkv").length).toBeGreaterThan(0);
    expect(
      validateProposedBasename("Trigger: S01E01.mkv", ".mkv").length
    ).toBeGreaterThan(0);
    expect(
      validateProposedBasename("Trigger S01E01.mkv.", ".mkv").length
    ).toBeGreaterThan(0);
    expect(
      validateProposedBasename("..\\Trigger S01E01.mkv", ".mkv").length
    ).toBeGreaterThan(0);
    expect(
      validateProposedBasename(`${"A".repeat(260)}.mkv`, ".mkv").length
    ).toBeGreaterThan(0);

    // T27: Same basename with distinct extensions (.mkv and .srt) -> valid distinct targets
    const videoItem = buildFileEntryFromRaw({
      id: "v1",
      name: "Trigger.S01E01.720p.mkv",
      directory: "C:\\Videos",
      sizeBytes: 100,
      modifiedAt: 1,
    });
    const subItem = buildFileEntryFromRaw({
      id: "s1",
      name: "Trigger.S01E01.720p.mp4",
      directory: "C:\\Videos",
      sizeBytes: 100,
      modifiedAt: 2,
    });
    const distinctExtValidated = validatePreviewBatch([videoItem, subItem]);
    expect(distinctExtValidated[0].status).toBe("ready");
    expect(distinctExtValidated[1].status).toBe("ready");
  });

  it("Phase 5 & 6 (T28, T29, T33, T38): validates confirmation token, executes 1,000-file batch accurately, handles separate subdirectories, and undoes batch", async () => {
    // T38: Recursive scan with identical filenames in different subdirectories -> separate paths (no false conflict)
    const sub1 = buildFileEntryFromRaw({
      id: "sub-1",
      name: "Trigger.S01E01.720p.mkv",
      directory: "C:\\Videos\\FolderA",
      sizeBytes: 100,
      modifiedAt: 1,
    });
    const sub2 = buildFileEntryFromRaw({
      id: "sub-2",
      name: "Trigger.S01E01.1080p.mkv",
      directory: "C:\\Videos\\FolderB",
      sizeBytes: 200,
      modifiedAt: 2,
    });
    const crossSubdirValidated = validatePreviewBatch([sub1, sub2]);
    expect(crossSubdirValidated[0].status).toBe("ready");
    expect(crossSubdirValidated[1].status).toBe("ready");

    // T29: Batch of 1,000 files -> correct counts and fast execution
    const batch1000 = Array.from({ length: 1000 }, (_, i) => {
      const season = Math.floor(i / 100) + 1;
      const episode = (i % 100) + 1;
      return buildFileEntryFromRaw({
        id: `b1000-${i}`,
        name: `Trigger.S${String(season).padStart(2, "0")}E${String(
          episode
        ).padStart(2, "0")}.1080p.WEB-DL.x265.mkv`,
        directory: "C:\\Videos\\LargeBatch",
        sizeBytes: 1024,
        modifiedAt: 1000 + i,
      });
    });

    const preflight = await validateRenamePlanCommand(batch1000);
    expect(preflight.valid).toBe(true);
    expect(preflight.confirmationToken).toMatch(/^confirm_/);

    const execResult = await executeRenamePlanCommand(
      preflight.entries,
      preflight.confirmationToken!
    );
    expect(execResult.renamedCount).toBe(1000);
    expect(execResult.failedCount).toBe(0);
    expect(execResult.canUndo).toBe(true);

    // T33: Undo successful batch -> original names restored safely
    const undoResult = await undoBatchCommand(execResult.operationId);
    expect(undoResult.renamedCount).toBe(1000);
    expect(undoResult.failedCount).toBe(0);
  });

  it("Phase 7 (Performance & T39): parses and validates 10,000 files cleanly and preserves non-ASCII titles with mixed-case extensions", () => {
    // T39: Non-ASCII characters and mixed-case extension (.MkV) preserved
    const t39 = analyzeFilename("괴물-אנחנו-進撃.S01E08.1080p.WEB-DL.MkV");
    expect(t39.needsReview).toBe(false);
    expect(t39.proposedName).toBe("괴물-אנחנו-進撃 S01E08.MkV");
    expect(t39.extension).toBe(".MkV");

    // 10,000 file batch parse & validation benchmark
    const batch10k = Array.from({ length: 10000 }, (_, i) => {
      const season = Math.floor(i / 200) + 1;
      const episode = (i % 200) + 1;
      return buildFileEntryFromRaw({
        id: `b10k-${i}`,
        name: `Trigger.S${String(season).padStart(2, "0")}E${String(
          episode
        ).padStart(3, "0")}.720p.x265.mkv`,
        directory: "C:\\Videos\\Benchmark10k",
        sizeBytes: 4096,
        modifiedAt: 5000 + i,
      });
    });

    const validated10k = validatePreviewBatch(batch10k);
    expect(validated10k.length).toBe(10000);
    expect(validated10k[0].status).toBe("ready");
    expect(validated10k[9999].status).toBe("ready");
  });
});
