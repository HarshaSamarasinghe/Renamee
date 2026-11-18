use crate::formatter::{
    format_episode_filename, normalize_series_title, split_stem_and_extension, ParseAnalysis,
    DEFAULT_PATTERN,
};
use crate::models::{MatchedSyntax, ParseConfidence, ParsedEpisode};
use once_cell::sync::Lazy;
use regex::Regex;

// Retained for backward compatibility with existing Phase 0 commands until Phase 2 replaces them
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecognitionStatus {
    Ready,
    Unchanged,
    Ambiguous,
    Unrecognized,
    DuplicateTarget,
    DiskConflict,
    InvalidChars,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedFilename {
    pub original_name: String,
    pub series_name: Option<String>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub episode_end: Option<u32>,
    pub extension: String,
    pub removed_tags: Vec<String>,
    pub suggested_name: String,
    pub status: RecognitionStatus,
    pub reason: Option<String>,
    pub pattern_matched: Option<String>,
}

#[derive(Debug, Clone)]
struct CandidateMatch {
    syntax: MatchedSyntax,
    byte_start: usize,
    full_match: String,
    season_str: String,
    episode_str: String,
}

static SXEY_TOKEN_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)[Ss](\d{1,2})[\s._\-]*[Ee](\d{1,4})").unwrap()
});

static NXM_TOKEN_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(\d{1,2})[xX](\d{1,4})").unwrap()
});

static MULTI_EP_CONTIGUOUS_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)[Ss]\d{1,2}[\s._\-]*[Ee]\d{1,4}[\s._\-]*(?:[-~][\s._\-]*[Ee]?|[Ee])\d{1,4}").unwrap()
});

static LEADING_GROUP_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\s*\[[^\]]+\]").unwrap()
});

fn is_valid_token_boundary(stem: &str, start: usize, end: usize) -> bool {
    let valid_left = if start == 0 {
        true
    } else {
        stem[..start]
            .chars()
            .next_back()
            .map(|c| matches!(c, '.' | ' ' | '_' | '-' | '[' | '('))
            .unwrap_or(false)
    };

    let valid_right = if end >= stem.len() {
        true
    } else {
        stem[end..]
            .chars()
            .next()
            .map(|c| !c.is_ascii_alphanumeric())
            .unwrap_or(true)
    };

    valid_left && valid_right
}

/// Pure deterministic filename recognition function implementing Section 5 of the Plan.
pub fn analyze_filename(original_name: &str, pattern: &str) -> ParseAnalysis {
    let trimmed = original_name.trim();
    if trimmed.is_empty() {
        return ParseAnalysis {
            stem: String::new(),
            extension: String::new(),
            parsed: None,
            proposed_name: None,
            needs_review: true,
            issues: vec!["Filename is empty".to_string()],
        };
    }

    let (stem, extension) = split_stem_and_extension(trimmed);
    if stem.is_empty() || trimmed.starts_with('.') {
        return ParseAnalysis {
            stem,
            extension,
            parsed: None,
            proposed_name: None,
            needs_review: true,
            issues: vec!["Hidden dotfile or missing filename stem".to_string()],
        };
    }

    if extension.is_empty() {
        return ParseAnalysis {
            stem,
            extension,
            parsed: None,
            proposed_name: None,
            needs_review: true,
            issues: vec!["Missing file extension".to_string()],
        };
    }

    // Check for multi-episode contiguous ranges like S01E01E02 or S01E01-E02
    for m in MULTI_EP_CONTIGUOUS_RE.find_iter(&stem) {
        if is_valid_token_boundary(&stem, m.start(), m.end()) {
            return ParseAnalysis {
                stem,
                extension,
                parsed: None,
                proposed_name: None,
                needs_review: true,
                issues: vec!["Multi-episode token detected; flagged for manual review".to_string()],
            };
        }
    }

    let mut candidates: Vec<CandidateMatch> = Vec::new();

    for caps in SXEY_TOKEN_RE.captures_iter(&stem) {
        if let Some(m) = caps.get(0) {
            if is_valid_token_boundary(&stem, m.start(), m.end()) {
                candidates.push(CandidateMatch {
                    syntax: MatchedSyntax::SxEy,
                    byte_start: m.start(),
                    full_match: m.as_str().to_string(),
                    season_str: caps[1].to_string(),
                    episode_str: caps[2].to_string(),
                });
            }
        }
    }

    for caps in NXM_TOKEN_RE.captures_iter(&stem) {
        if let Some(m) = caps.get(0) {
            if is_valid_token_boundary(&stem, m.start(), m.end()) {
                candidates.push(CandidateMatch {
                    syntax: MatchedSyntax::NxM,
                    byte_start: m.start(),
                    full_match: m.as_str().to_string(),
                    season_str: caps[1].to_string(),
                    episode_str: caps[2].to_string(),
                });
            }
        }
    }

    if candidates.is_empty() {
        return ParseAnalysis {
            stem,
            extension,
            parsed: None,
            proposed_name: None,
            needs_review: true,
            issues: vec![
                "No explicit Season/Episode token (SxxExx or NxNN) found".to_string(),
            ],
        };
    }

    if candidates.len() > 1 {
        let joined = candidates
            .iter()
            .map(|c| c.full_match.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        return ParseAnalysis {
            stem,
            extension,
            parsed: None,
            proposed_name: None,
            needs_review: true,
            issues: vec![format!(
                "Ambiguous filename: multiple episode tokens found ({})",
                joined
            )],
        };
    }

    let chosen = &candidates[0];
    let raw_prefix = &stem[..chosen.byte_start];

    if LEADING_GROUP_RE.is_match(raw_prefix) {
        return ParseAnalysis {
            stem,
            extension,
            parsed: None,
            proposed_name: None,
            needs_review: true,
            issues: vec![
                "Contains leading release group bracket prefix; please review series title"
                    .to_string(),
            ],
        };
    }

    let normalized_series = normalize_series_title(raw_prefix);
    if normalized_series.is_empty() {
        return ParseAnalysis {
            stem,
            extension,
            parsed: None,
            proposed_name: None,
            needs_review: true,
            issues: vec!["Missing series title before episode token".to_string()],
        };
    }

    let (season, episode) = match (
        chosen.season_str.parse::<u32>(),
        chosen.episode_str.parse::<u32>(),
    ) {
        (Ok(s), Ok(e)) => (s, e),
        _ => {
            return ParseAnalysis {
                stem,
                extension,
                parsed: None,
                proposed_name: None,
                needs_review: true,
                issues: vec!["Failed to parse numeric season or episode value".to_string()],
            };
        }
    };

    let confidence = match chosen.syntax {
        MatchedSyntax::SxEy => ParseConfidence::High,
        _ => ParseConfidence::Medium,
    };

    let explanation = format!(
        "Matched {:?} token '{}' -> Series '{}', Season {}, Episode {}",
        chosen.syntax, chosen.full_match, normalized_series, season, episode
    );

    let parsed = ParsedEpisode {
        series: normalized_series.clone(),
        season,
        episode,
        season_digits: chosen.season_str.len(),
        episode_digits: chosen.episode_str.len(),
        matched_syntax: chosen.syntax.clone(),
        confidence,
        explanation,
    };

    let proposed_name = format_episode_filename(
        &normalized_series,
        season,
        episode,
        &extension,
        pattern,
    );

    ParseAnalysis {
        stem,
        extension,
        parsed: Some(parsed),
        proposed_name: Some(proposed_name),
        needs_review: false,
        issues: Vec::new(),
    }
}

pub fn validate_windows_filename(filename: &str) -> Result<(), String> {
    if filename.trim().is_empty() {
        return Err("Filename cannot be empty".to_string());
    }
    let invalid_chars = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    if filename.chars().any(|c| invalid_chars.contains(&c)) {
        return Err("Contains invalid Windows filename characters (< > : \" / \\ | ? *)".to_string());
    }
    let (stem, _) = split_stem_and_extension(filename);
    let reserved = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if reserved.contains(&stem.to_uppercase().as_str()) {
        return Err(format!("'{}' is a reserved Windows system name", stem));
    }
    Ok(())
}

/// Compatibility adapter for existing UI until Phase 2 connects the new DTOs
pub fn parse_filename(filename: &str) -> ParsedFilename {
    let analysis = analyze_filename(filename, DEFAULT_PATTERN);
    if let (Some(parsed), Some(proposed)) = (analysis.parsed, analysis.proposed_name) {
        let status = if proposed == filename {
            RecognitionStatus::Unchanged
        } else {
            RecognitionStatus::Ready
        };
        ParsedFilename {
            original_name: filename.to_string(),
            series_name: Some(parsed.series),
            season: Some(parsed.season),
            episode: Some(parsed.episode),
            episode_end: None,
            extension: analysis.extension,
            removed_tags: Vec::new(),
            suggested_name: proposed,
            status,
            reason: None,
            pattern_matched: Some(format!("{:?}", parsed.matched_syntax)),
        }
    } else {
        ParsedFilename {
            original_name: filename.to_string(),
            series_name: None,
            season: None,
            episode: None,
            episode_end: None,
            extension: analysis.extension,
            removed_tags: Vec::new(),
            suggested_name: filename.to_string(),
            status: RecognitionStatus::Ambiguous,
            reason: analysis.issues.first().cloned(),
            pattern_matched: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_phase1_matrix_t01_to_t07() {
        let cases = vec![
            (
                "T01",
                "Trigger.S01E01.x265.720p.WEB-EDITH.mkv",
                "Trigger S01E01.mkv",
                "Trigger",
                1,
                1,
                ".mkv",
            ),
            (
                "T02",
                "Trigger.S01E02.x265.720p.jshbsdkh-webrip.mkv",
                "Trigger S01E02.mkv",
                "Trigger",
                1,
                2,
                ".mkv",
            ),
            (
                "T02b",
                "Trigger.S01_E03.x265.720p.wefi-helman.mkv",
                "Trigger S01E03.mkv",
                "Trigger",
                1,
                3,
                ".mkv",
            ),
            (
                "T03",
                "Trigger.S01.E10.x265.720p-WEB-randomvideo.mkv",
                "Trigger S01E10.mkv",
                "Trigger",
                1,
                10,
                ".mkv",
            ),
            (
                "T04",
                "Trigger.S1E2.1080p.mp4",
                "Trigger S01E02.mp4",
                "Trigger",
                1,
                2,
                ".mp4",
            ),
            (
                "T05",
                "Trigger.1x03.HDTV.avi",
                "Trigger S01E03.avi",
                "Trigger",
                1,
                3,
                ".avi",
            ),
            (
                "T06",
                "My.Show.Name.S03E12.mkv",
                "My Show Name S03E12.mkv",
                "My Show Name",
                3,
                12,
                ".mkv",
            ),
            (
                "T07",
                "My.Show.S02E107.WEBRip.MKV",
                "My Show S02E107.MKV",
                "My Show",
                2,
                107,
                ".MKV",
            ),
        ];

        for (id, input, exp_name, exp_series, exp_s, exp_e, exp_ext) in cases {
            let res = analyze_filename(input, DEFAULT_PATTERN);
            assert!(!res.needs_review, "{} should not need review", id);
            assert_eq!(res.proposed_name.as_deref(), Some(exp_name), "{} name", id);
            let p = res.parsed.expect("parsed episode");
            assert_eq!(p.series, exp_series, "{} series", id);
            assert_eq!(p.season, exp_s, "{} season", id);
            assert_eq!(p.episode, exp_e, "{} episode", id);
            assert_eq!(res.extension, exp_ext, "{} extension", id);
        }
    }

    #[test]
    fn test_phase1_matrix_t08_to_t15_edge_and_ambiguity_cases() {
        // T08: filename without episode
        let t08 = analyze_filename("filename_without_episode.mkv", DEFAULT_PATTERN);
        assert!(t08.needs_review);
        assert!(t08.proposed_name.is_none());

        // T09: multiple conflicting episode tokens
        let t09 = analyze_filename("Show.S01E01.S02E05.mkv", DEFAULT_PATTERN);
        assert!(t09.needs_review);
        assert!(t09.proposed_name.is_none());

        // T10, T11, T12: missing episode gaps, different seasons, independent series
        let e1 = analyze_filename("Show.S01E01.mkv", DEFAULT_PATTERN);
        let e3 = analyze_filename("Show.S01E03.mkv", DEFAULT_PATTERN);
        let s2 = analyze_filename("Show.S02E01.mkv", DEFAULT_PATTERN);
        let other = analyze_filename("Other.Show.S01E01.mkv", DEFAULT_PATTERN);
        assert_eq!(e1.proposed_name.as_deref(), Some("Show S01E01.mkv"));
        assert_eq!(e3.proposed_name.as_deref(), Some("Show S01E03.mkv"));
        assert_eq!(s2.proposed_name.as_deref(), Some("Show S02E01.mkv"));
        assert_eq!(other.proposed_name.as_deref(), Some("Other Show S01E01.mkv"));

        // T13: Unicode title and title containing word "Web"
        let unicode = analyze_filename("進撃の巨人.S04E28.1080p.WEB-DL.mkv", DEFAULT_PATTERN);
        assert!(!unicode.needs_review);
        assert_eq!(unicode.proposed_name.as_deref(), Some("進撃の巨人 S04E28.mkv"));

        let web_title = analyze_filename("Charlotte's.Web.S01E02.720p.mkv", DEFAULT_PATTERN);
        assert!(!web_title.needs_review);
        assert_eq!(
            web_title.proposed_name.as_deref(),
            Some("Charlotte's Web S01E02.mkv")
        );

        // T14: empty name, dotfile, missing extension
        assert!(analyze_filename("", DEFAULT_PATTERN).needs_review);
        assert!(analyze_filename(".gitignore", DEFAULT_PATTERN).needs_review);
        assert!(analyze_filename("video_without_ext", DEFAULT_PATTERN).needs_review);

        // T15: year and release tokens without episode token
        let t15 = analyze_filename("Movie.Title.2025.1080p.WEB-DL.x265.mkv", DEFAULT_PATTERN);
        assert!(t15.needs_review);
        assert!(t15.proposed_name.is_none());
    }
}
