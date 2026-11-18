use crate::models::{MatchedSyntax, ParseConfidence, ParsedEpisode};
use serde::{Deserialize, Serialize};

pub const DEFAULT_PATTERN: &str = "{series} S{season:02}E{episode:02}{extension}";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseAnalysis {
    pub stem: String,
    pub extension: String,
    pub parsed: Option<ParsedEpisode>,
    pub proposed_name: Option<String>,
    pub needs_review: bool,
    pub issues: Vec<String>,
}

/// Step A: Split final extension using last-dot logic, with special handling
/// for dotfiles (e.g. ".gitignore") and empty stems. Preserves exact extension casing.
pub fn split_stem_and_extension(filename: &str) -> (String, String) {
    if filename.is_empty() {
        return (String::new(), String::new());
    }
    if let Some(last_dot) = filename.rfind('.') {
        if last_dot > 0 && last_dot < filename.len() - 1 {
            return (
                filename[..last_dot].to_string(),
                filename[last_dot..].to_string(),
            );
        }
    }
    (filename.to_string(), String::new())
}

/// Step D: Normalize title separators ('.' and '_') to spaces, collapse whitespace,
/// and trim leading/trailing separator punctuation without stripping real title words (like "WEB").
pub fn normalize_series_title(raw_prefix: &str) -> String {
    let replaced: String = raw_prefix
        .chars()
        .map(|c| if c == '.' || c == '_' { ' ' } else { c })
        .collect();

    let trimmed = replaced.trim_matches(|c: char| {
        c.is_whitespace() || c == '-' || c == '–' || c == '—' || c == ':'
    });

    trimmed.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Formats season and episode numbers with a minimum width of 2 digits,
/// never truncating episode numbers >= 100 (e.g. 107 -> "107", 3 -> "03").
pub fn format_number_min_width_2(num: u32) -> String {
    format!("{:02}", num)
}

/// Builds the formatted filename from a ParsedEpisode and any preset or custom template string.
pub fn format_episode_filename(
    series_title: &str,
    season: u32,
    episode: u32,
    extension: &str,
    pattern: &str,
) -> String {
    let clean_series = series_title.trim();
    let dot_series = clean_series.split_whitespace().collect::<Vec<_>>().join(".");
    let under_series = clean_series.split_whitespace().collect::<Vec<_>>().join("_");
    let s_pad2 = format!("{:02}", season);
    let s_pad3 = format!("{:03}", season);
    let e_pad2 = format!("{:02}", episode);
    let e_pad3 = format!("{:03}", episode);

    let active_pattern = if pattern.trim().is_empty() {
        DEFAULT_PATTERN
    } else {
        pattern.trim()
    };

    if active_pattern == "{series}.S{season:02}E{episode:02}{extension}" {
        return format!("{}.S{}E{}{}", dot_series, s_pad2, e_pad2, extension);
    }

    let has_ext_token = active_pattern.contains("{extension}") || active_pattern.contains("{ext}");

    let mut result = active_pattern
        .replace("{series.dots}", &dot_series)
        .replace("{series.underscores}", &under_series)
        .replace("{series}", clean_series)
        .replace("{season:03}", &s_pad3)
        .replace("{season:02}", &s_pad2)
        .replace("{s00}", &s_pad2)
        .replace("{season}", &season.to_string())
        .replace("{s}", &season.to_string())
        .replace("{episode:03}", &e_pad3)
        .replace("{e000}", &e_pad3)
        .replace("{episode:02}", &e_pad2)
        .replace("{e00}", &e_pad2)
        .replace("{episode}", &episode.to_string())
        .replace("{e}", &episode.to_string())
        .replace("{extension}", extension)
        .replace("{ext}", extension);

    if !has_ext_token
        && !extension.is_empty()
        && !result.to_lowercase().ends_with(&extension.to_lowercase())
    {
        result.push_str(extension);
    }

    result
}

pub fn get_series_season_group_key(parsed: &ParsedEpisode) -> String {
    format!("{}::s{}", parsed.series.to_lowercase(), parsed.season)
}
