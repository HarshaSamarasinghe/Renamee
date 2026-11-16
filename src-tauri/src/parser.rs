use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

static STANDARD_SE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^(?P<series>.+?)[.\s_\-\[\(]+S(?P<season>\d{1,2})[\s._\-]*E(?P<ep>\d{1,3})(?:(?:[\s._\-]*[-~][\s._\-]*E?|[\s._\-]+E)(?P<ep2>\d{1,3}))?(?:[^a-zA-Z0-9]|$)(?P<rest>.*)$").unwrap()
});

static X_FORMAT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^(?P<series>.+?)[.\s_\-\[\(]+(?P<season>\d{1,2})x(?P<ep>\d{1,3})(?:[-~](?:(?:\d{1,2}x)?(?P<ep2>\d{1,3})))?(?:[^a-zA-Z0-9]|$)(?P<rest>.*)$").unwrap()
});

static SPELLED_SE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^(?P<series>.+?)[.\s_\-\[\(]+Season[\s._\-]*(?P<season>\d{1,2})[\s._\-,]+Episode[\s._\-]*(?P<ep>\d{1,3})(?:[\s._\-]*[-~][\s._\-]*(?P<ep2>\d{1,3}))?(?:[^a-zA-Z0-9]|$)(?P<rest>.*)$").unwrap()
});

static EP_ONLY_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^(?P<series>.+?)[.\s_\-\[\(]+(?:E|EP|Episode)[\s._\-]*(?P<ep>\d{1,3})(?:[^a-zA-Z0-9]|$)(?P<rest>.*)$").unwrap()
});

static COMPACT_NUMERIC_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^(?P<series>.+?)[.\s_\-]+(?P<num>\d{3,4})(?:[^a-zA-Z0-9]|$)(?P<rest>.*)$").unwrap()
});

static LEADING_BRACKET_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\[(?P<tag>[^\]]+)\][\s._\-]*(?P<remainder>.+)$").unwrap()
});

static KNOWN_TAG_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^(?:480p|540p|720p|1080p|1080i|1440p|2160p|4k|8k|uhd|fhd|hd|sd|x264|x265|h264|h265|hevc|avc|av1|xvid|divx|vp9|10bit|8bit|hdr|hdr10|hdr10plus|dv|dovi|dolby|vision|web-dl|webdl|webrip|web|bluray|blu-ray|bdrip|brrip|remux|hdrip|hdtv|pdtv|dvdrip|dvdscr|cam|ts|tc|aac|aac2|ac3|eac3|ddp|ddp5|dd5|dts|dts-hd|truehd|atmos|flac|mp3|opus|dual|multi|dubbed|subbed|subs|esub|esubs|proper|repack|rerip|internal|limited|extended|uncut|directors|nf|amzn|dsnp|atvp|hmax|hulu|pcok|bbc|itunes|cr)$").unwrap()
});

static WINDOWS_RESERVED_NAMES: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ]
    .into_iter()
    .collect()
});

pub fn split_stem_and_extension(filename: &str) -> (&str, String) {
    if let Some(idx) = filename.rfind('.') {
        if idx > 0 && idx < filename.len() - 1 {
            return (&filename[..idx], filename[idx..].to_string());
        }
    }
    (filename, String::new())
}

fn clean_series_name(raw_series: &str, removed_tags: &mut Vec<String>) -> String {
    let mut working = raw_series.trim().to_string();

    while let Some(caps) = LEADING_BRACKET_RE.captures(&working) {
        let tag = caps.name("tag").map(|m| m.as_str().to_string()).unwrap_or_default();
        let rem = caps.name("remainder").map(|m| m.as_str().to_string()).unwrap_or_default();
        if !tag.is_empty() {
            removed_tags.push(format!("[{}]", tag));
        }
        working = rem;
    }

    let replaced: String = working
        .chars()
        .map(|c| match c {
            '.' | '_' => ' ',
            _ => c,
        })
        .collect();

    let mut tokens: Vec<&str> = replaced
        .split_whitespace()
        .map(|t| t.trim_matches(|c: char| c == '-' || c == '[' || c == ']' || c == '(' || c == ')'))
        .filter(|t| !t.is_empty())
        .collect();

    while let Some(&last) = tokens.last() {
        if KNOWN_TAG_RE.is_match(last) {
            removed_tags.push(last.to_string());
            tokens.pop();
        } else {
            break;
        }
    }

    let joined = tokens.join(" ");
    sanitize_windows_component(&joined)
}

fn extract_metadata_tags(rest: &str, removed_tags: &mut Vec<String>) {
    let cleaned = rest.trim();
    if cleaned.is_empty() {
        return;
    }

    for part in cleaned.split(|c: char| c == '.' || c == '_' || c == ' ' || c == '[' || c == ']' || c == '(' || c == ')') {
        let trimmed = part.trim_matches('-').trim();
        if !trimmed.is_empty() {
            removed_tags.push(trimmed.to_string());
        }
    }
}

pub fn sanitize_windows_component(input: &str) -> String {
    let filtered: String = input
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => ' ',
            _ => c,
        })
        .collect();

    filtered
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_end_matches('.')
        .to_string()
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
    if WINDOWS_RESERVED_NAMES.contains(stem.to_uppercase().as_str()) {
        return Err(format!("'{}' is a reserved Windows system name", stem));
    }
    Ok(())
}

pub fn parse_filename(filename: &str) -> ParsedFilename {
    let (stem, extension) = split_stem_and_extension(filename);
    let mut removed_tags = Vec::new();

    // 1. Standard S01E01 / s1e1 / S01E01-E02
    if let Some(caps) = STANDARD_SE_RE.captures(stem) {
        let raw_series = caps.name("series").map(|m| m.as_str()).unwrap_or("");
        let season_str = caps.name("season").map(|m| m.as_str()).unwrap_or("");
        let ep_str = caps.name("ep").map(|m| m.as_str()).unwrap_or("");
        let ep2_str = caps.name("ep2").map(|m| m.as_str());
        let rest = caps.name("rest").map(|m| m.as_str()).unwrap_or("");

        if let (Ok(season), Ok(episode)) = (season_str.parse::<u32>(), ep_str.parse::<u32>()) {
            let episode_end = ep2_str.and_then(|s| s.parse::<u32>().ok());
            let series_name = clean_series_name(raw_series, &mut removed_tags);
            extract_metadata_tags(rest, &mut removed_tags);

            if !series_name.is_empty() {
                let ep_formatted = match episode_end {
                    Some(end) if end > episode => format!("S{:02}E{:02}-E{:02}", season, episode, end),
                    _ => format!("S{:02}E{:02}", season, episode),
                };
                let suggested_name = format!("{} {}{}", series_name, ep_formatted, extension);
                let status = if suggested_name == filename {
                    RecognitionStatus::Unchanged
                } else {
                    RecognitionStatus::Ready
                };

                return ParsedFilename {
                    original_name: filename.to_string(),
                    series_name: Some(series_name),
                    season: Some(season),
                    episode: Some(episode),
                    episode_end,
                    extension,
                    removed_tags,
                    suggested_name,
                    status,
                    reason: None,
                    pattern_matched: Some("Standard SxxExx".to_string()),
                };
            }
        }
    }

    // 2. 1x01 / 01x02 format
    if let Some(caps) = X_FORMAT_RE.captures(stem) {
        let raw_series = caps.name("series").map(|m| m.as_str()).unwrap_or("");
        let season_str = caps.name("season").map(|m| m.as_str()).unwrap_or("");
        let ep_str = caps.name("ep").map(|m| m.as_str()).unwrap_or("");
        let ep2_str = caps.name("ep2").map(|m| m.as_str());
        let rest = caps.name("rest").map(|m| m.as_str()).unwrap_or("");

        if let (Ok(season), Ok(episode)) = (season_str.parse::<u32>(), ep_str.parse::<u32>()) {
            let episode_end = ep2_str.and_then(|s| s.parse::<u32>().ok());
            let series_name = clean_series_name(raw_series, &mut removed_tags);
            extract_metadata_tags(rest, &mut removed_tags);

            if !series_name.is_empty() {
                let ep_formatted = match episode_end {
                    Some(end) if end > episode => format!("S{:02}E{:02}-E{:02}", season, episode, end),
                    _ => format!("S{:02}E{:02}", season, episode),
                };
                let suggested_name = format!("{} {}{}", series_name, ep_formatted, extension);
                let status = if suggested_name == filename {
                    RecognitionStatus::Unchanged
                } else {
                    RecognitionStatus::Ready
                };

                return ParsedFilename {
                    original_name: filename.to_string(),
                    series_name: Some(series_name),
                    season: Some(season),
                    episode: Some(episode),
                    episode_end,
                    extension,
                    removed_tags,
                    suggested_name,
                    status,
                    reason: None,
                    pattern_matched: Some("NxNN (1x01)".to_string()),
                };
            }
        }
    }

    // 3. Spelled out Season 1 Episode 02
    if let Some(caps) = SPELLED_SE_RE.captures(stem) {
        let raw_series = caps.name("series").map(|m| m.as_str()).unwrap_or("");
        let season_str = caps.name("season").map(|m| m.as_str()).unwrap_or("");
        let ep_str = caps.name("ep").map(|m| m.as_str()).unwrap_or("");
        let ep2_str = caps.name("ep2").map(|m| m.as_str());
        let rest = caps.name("rest").map(|m| m.as_str()).unwrap_or("");

        if let (Ok(season), Ok(episode)) = (season_str.parse::<u32>(), ep_str.parse::<u32>()) {
            let episode_end = ep2_str.and_then(|s| s.parse::<u32>().ok());
            let series_name = clean_series_name(raw_series, &mut removed_tags);
            extract_metadata_tags(rest, &mut removed_tags);

            if !series_name.is_empty() {
                let ep_formatted = match episode_end {
                    Some(end) if end > episode => format!("S{:02}E{:02}-E{:02}", season, episode, end),
                    _ => format!("S{:02}E{:02}", season, episode),
                };
                let suggested_name = format!("{} {}{}", series_name, ep_formatted, extension);
                let status = if suggested_name == filename {
                    RecognitionStatus::Unchanged
                } else {
                    RecognitionStatus::Ready
                };

                return ParsedFilename {
                    original_name: filename.to_string(),
                    series_name: Some(series_name),
                    season: Some(season),
                    episode: Some(episode),
                    episode_end,
                    extension,
                    removed_tags,
                    suggested_name,
                    status,
                    reason: None,
                    pattern_matched: Some("Spelled Season/Episode".to_string()),
                };
            }
        }
    }

    // 4. Ambiguous check: Episode only (no season specified) or 3-digit compact number (like 101 or 2024 year)
    if let Some(caps) = EP_ONLY_RE.captures(stem) {
        let raw_series = caps.name("series").map(|m| m.as_str()).unwrap_or("");
        let ep_str = caps.name("ep").map(|m| m.as_str()).unwrap_or("");
        let rest = caps.name("rest").map(|m| m.as_str()).unwrap_or("");
        if let Ok(episode) = ep_str.parse::<u32>() {
            let series_name = clean_series_name(raw_series, &mut removed_tags);
            extract_metadata_tags(rest, &mut removed_tags);
            let suggested_name = if !series_name.is_empty() {
                format!("{} S01E{:02}{}", series_name, episode, extension)
            } else {
                filename.to_string()
            };

            return ParsedFilename {
                original_name: filename.to_string(),
                series_name: if series_name.is_empty() { None } else { Some(series_name) },
                season: None,
                episode: Some(episode),
                episode_end: None,
                extension,
                removed_tags,
                suggested_name,
                status: RecognitionStatus::Ambiguous,
                reason: Some("Episode number found without explicit Season number (defaulting preview to S01, flagged as ambiguous)".to_string()),
                pattern_matched: Some("Episode-Only (Ambiguous)".to_string()),
            };
        }
    }

    if let Some(caps) = COMPACT_NUMERIC_RE.captures(stem) {
        let num_str = caps.name("num").map(|m| m.as_str()).unwrap_or("");
        let raw_series = caps.name("series").map(|m| m.as_str()).unwrap_or("");
        let series_name = clean_series_name(raw_series, &mut removed_tags);
        let reason = if num_str == "720" || num_str == "1080" || num_str == "2160" || (num_str.len() == 4 && (num_str.starts_with("19") || num_str.starts_with("20"))) {
            "Contains year or resolution number without explicit Season/Episode marker".to_string()
        } else {
            format!("Contains ambiguous numeric sequence '{}' without explicit S/E or NxNN marker", num_str)
        };

        return ParsedFilename {
            original_name: filename.to_string(),
            series_name: if series_name.is_empty() { None } else { Some(series_name) },
            season: None,
            episode: None,
            episode_end: None,
            extension,
            removed_tags,
            suggested_name: filename.to_string(),
            status: RecognitionStatus::Ambiguous,
            reason: Some(reason),
            pattern_matched: None,
        };
    }

    ParsedFilename {
        original_name: filename.to_string(),
        series_name: None,
        season: None,
        episode: None,
        episode_end: None,
        extension,
        removed_tags: Vec::new(),
        suggested_name: filename.to_string(),
        status: RecognitionStatus::Unrecognized,
        reason: Some("No recognizable Season/Episode pattern found".to_string()),
        pattern_matched: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_trigger_user_scenario() {
        let examples = vec![
            ("Trigger.S01E01.x265.720p.WEB-EDITH.mkv", "Trigger S01E01.mkv", 1, 1),
            ("Trigger.S01E02.x265.720p.WEB-EDITH.mkv", "Trigger S01E02.mkv", 1, 2),
            ("Trigger.S01E03.x265.720p.WEB-EDITH.mkv", "Trigger S01E03.mkv", 1, 3),
            ("Trigger.S01E04.x265.720p.WEB-EDITH.mkv", "Trigger S01E04.mkv", 1, 4),
        ];

        for (input, expected, exp_s, exp_e) in examples {
            let parsed = parse_filename(input);
            assert_eq!(parsed.status, RecognitionStatus::Ready);
            assert_eq!(parsed.series_name.as_deref(), Some("Trigger"));
            assert_eq!(parsed.season, Some(exp_s));
            assert_eq!(parsed.episode, Some(exp_e));
            assert_eq!(parsed.extension, ".mkv");
            assert_eq!(parsed.suggested_name, expected);
            assert!(parsed.removed_tags.contains(&"x265".to_string()));
            assert!(parsed.removed_tags.contains(&"720p".to_string()));
        }
    }

    #[test]
    fn test_variations_and_separators() {
        let p1 = parse_filename("Severance_s1e9_1080p_WEB-DL_AAC2.0_H.264-NTb.mp4");
        assert_eq!(p1.suggested_name, "Severance S01E09.mp4");
        assert_eq!(p1.status, RecognitionStatus::Ready);

        let p2 = parse_filename("The.Last.Of.Us.1x05.BluRay.1080p.x264.mkv");
        assert_eq!(p2.suggested_name, "The Last Of Us S01E05.mkv");
        assert_eq!(p2.status, RecognitionStatus::Ready);

        let p3 = parse_filename("Arcane - Season 2 Episode 3 - 2160p HDR DV.mkv");
        assert_eq!(p3.suggested_name, "Arcane S02E03.mkv");
        assert_eq!(p3.status, RecognitionStatus::Ready);

        let p4 = parse_filename("Avatar.The.Last.Airbender.S03E20-E21.1080p.BluRay.mkv");
        assert_eq!(p4.suggested_name, "Avatar The Last Airbender S03E20-E21.mkv");
        assert_eq!(p4.status, RecognitionStatus::Ready);
    }

    #[test]
    fn test_ambiguous_and_unrecognized_never_guesses() {
        let ambig = parse_filename("Naruto_Ep14_720p.mkv");
        assert_eq!(ambig.status, RecognitionStatus::Ambiguous);

        let movie = parse_filename("Dune.Part.Two.2024.1080p.WEB-DL.mkv");
        assert_eq!(movie.status, RecognitionStatus::Ambiguous);

        let random = parse_filename("vacation_video_final_cut.mp4");
        assert_eq!(random.status, RecognitionStatus::Unrecognized);
    }
}
