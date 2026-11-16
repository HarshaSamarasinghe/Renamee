import { describe, expect, it } from "vitest";
import {
  evaluateBatchStatuses,
  FileScanItem,
  parseFilename,
  validateWindowsFilename,
} from "../lib/parser";

describe("Smart Bulk File Renamer - Recognition Engine", () => {
  it("recognizes the Trigger S01E01..S01E04 user scenario accurately", () => {
    const inputs = [
      {
        raw: "Trigger.S01E01.x265.720p.WEB-EDITH.mkv",
        expected: "Trigger S01E01.mkv",
        ep: 1,
      },
      {
        raw: "Trigger.S01E02.x265.720p.WEB-EDITH.mkv",
        expected: "Trigger S01E02.mkv",
        ep: 2,
      },
      {
        raw: "Trigger.S01E03.x265.720p.WEB-EDITH.mkv",
        expected: "Trigger S01E03.mkv",
        ep: 3,
      },
      {
        raw: "Trigger.S01E04.x265.720p.WEB-EDITH.mkv",
        expected: "Trigger S01E04.mkv",
        ep: 4,
      },
    ];

    for (const item of inputs) {
      const parsed = parseFilename(item.raw);
      expect(parsed.status).toBe("ready");
      expect(parsed.seriesName).toBe("Trigger");
      expect(parsed.season).toBe(1);
      expect(parsed.episode).toBe(item.ep);
      expect(parsed.extension).toBe(".mkv");
      expect(parsed.suggestedName).toBe(item.expected);
      expect(parsed.removedTags).toContain("x265");
      expect(parsed.removedTags).toContain("720p");
    }
  });

  it("handles s1e1, 1x01, Season/Episode, and multi-episode variations", () => {
    expect(parseFilename("Severance_s1e9_1080p_WEB-DL.mp4").suggestedName).toBe(
      "Severance S01E09.mp4"
    );
    expect(
      parseFilename("The.Last.Of.Us.1x05.BluRay.1080p.x264.mkv").suggestedName
    ).toBe("The Last Of Us S01E05.mkv");
    expect(
      parseFilename("Arcane - Season 2 Episode 3 - 2160p HDR.mkv").suggestedName
    ).toBe("Arcane S02E03.mkv");
    expect(
      parseFilename("Avatar.The.Last.Airbender.S03E20-E21.1080p.mkv")
        .suggestedName
    ).toBe("Avatar The Last Airbender S03E20-E21.mkv");
  });

  it("handles missing episodes, mixed series, and different seasons independently without inventing order", () => {
    const batch = [
      "Trigger.S01E01.720p.mkv",
      "Trigger.S01E05.720p.mkv",
      "Trigger.S02E03.720p.mkv",
      "Silo.S01E02.1080p.mp4",
    ].map(parseFilename);

    expect(batch[0].suggestedName).toBe("Trigger S01E01.mkv");
    expect(batch[1].suggestedName).toBe("Trigger S01E05.mkv");
    expect(batch[2].suggestedName).toBe("Trigger S02E03.mkv");
    expect(batch[3].suggestedName).toBe("Silo S01E02.mp4");
  });

  it("flags ambiguous and unrecognized filenames instead of guessing", () => {
    const epOnly = parseFilename("One_Piece_Ep104_720p.mkv");
    expect(epOnly.status).toBe("ambiguous");

    const yearMovie = parseFilename("Oppenheimer.2023.2160p.UHD.BluRay.mkv");
    expect(yearMovie.status).toBe("ambiguous");

    const randomClip = parseFilename("Behind_The_Scenes_Interview.mp4");
    expect(randomClip.status).toBe("unrecognized");
  });

  it("detects duplicate destination targets and disk conflicts before renaming", () => {
    const items: FileScanItem[] = [
      {
        id: "1",
        folderPath: "C:\\Videos",
        originalName: "Trigger.S01E01.720p.mkv",
        fullPath: "C:\\Videos\\Trigger.S01E01.720p.mkv",
        sizeBytes: 1000,
        isVideo: true,
        parsed: parseFilename("Trigger.S01E01.720p.mkv"),
      },
      {
        id: "2",
        folderPath: "C:\\Videos",
        originalName: "Trigger.S01E01.1080p.mkv",
        fullPath: "C:\\Videos\\Trigger.S01E01.1080p.mkv",
        sizeBytes: 2000,
        isVideo: true,
        parsed: parseFilename("Trigger.S01E01.1080p.mkv"),
      },
      {
        id: "3",
        folderPath: "C:\\Videos",
        originalName: "Trigger.S01E02.1080p.mkv",
        fullPath: "C:\\Videos\\Trigger.S01E02.1080p.mkv",
        sizeBytes: 2000,
        isVideo: true,
        parsed: parseFilename("Trigger.S01E02.1080p.mkv"),
      },
    ];

    const existingDisk = new Set(["trigger s01e02.mkv"]);
    const evaluated = evaluateBatchStatuses(items, existingDisk);

    expect(evaluated[0].parsed.status).toBe("duplicate_target");
    expect(evaluated[1].parsed.status).toBe("duplicate_target");
    expect(evaluated[2].parsed.status).toBe("disk_conflict");
  });

  it("allows case-only renames on Windows without false self-conflict", () => {
    const item: FileScanItem = {
      id: "1",
      folderPath: "C:\\Videos",
      originalName: "trigger s01e01.mkv",
      fullPath: "C:\\Videos\\trigger s01e01.mkv",
      sizeBytes: 1000,
      isVideo: true,
      parsed: parseFilename("trigger s01e01.mkv"),
    };

    const existingDisk = new Set(["trigger s01e01.mkv"]);
    const evaluated = evaluateBatchStatuses([item], existingDisk);

    expect(evaluated[0].parsed.suggestedName).toBe("trigger S01E01.mkv");
    expect(evaluated[0].parsed.status).toBe("ready");
  });

  it("validates Windows illegal characters and reserved device names", () => {
    expect(validateWindowsFilename("Trigger: S01E01.mkv")).not.toBeNull();
    expect(validateWindowsFilename("CON.mkv")).not.toBeNull();
    expect(validateWindowsFilename("Trigger S01E01.mkv")).toBeNull();
  });
});
