//! Parse the well-known provider response headers (the same ones
//! Shadowsocks / sing-box / Clash Meta / xray clients understand).
//!
//! We only read allowlisted headers and only ever put them into the
//! `ProviderMetadata` struct, which is part of the sanitized summary
//! — no raw header values ever cross the IPC boundary.

use chrono::{DateTime, Utc};
use reqwest::header::HeaderMap;
use url::Url;

use crate::error::AppResult;

use super::model::{ProviderMetadata, SubscriptionUserinfo};

const MIN_UPDATE_MINUTES: u32 = 15;
const MAX_UPDATE_MINUTES: u32 = 30 * 24 * 60;

pub fn parse_metadata(headers: &HeaderMap) -> AppResult<ProviderMetadata> {
    let profile_title = header_text(headers, "profile-title")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    // Provider convention: Profile-Update-Interval is expressed in hours and may be decimal.
    let update_interval_minutes =
        header_text(headers, "profile-update-interval").and_then(parse_update_interval_minutes);
    let update_interval_hours = update_interval_minutes
        .filter(|minutes| minutes % 60 == 0)
        .map(|minutes| minutes / 60);
    let profile_web_page_url = header_text(headers, "profile-web-page-url").and_then(parse_web_url);
    let support_url = header_text(headers, "support-url").and_then(parse_web_url);
    let userinfo = header_text(headers, "subscription-userinfo").and_then(parse_userinfo);

    Ok(ProviderMetadata {
        profile_title,
        update_interval_minutes,
        update_interval_hours,
        profile_web_page_url,
        support_url,
        upload_bytes: userinfo.as_ref().and_then(|value| value.upload),
        download_bytes: userinfo.as_ref().and_then(|value| value.download),
        total_bytes: userinfo.as_ref().and_then(|value| value.total),
        expires_at: userinfo.as_ref().and_then(|value| value.expire),
        userinfo,
    })
}

fn header_text<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok()
}

fn parse_update_interval_minutes(value: &str) -> Option<u32> {
    let hours = value.trim().parse::<f64>().ok()?;
    if !hours.is_finite() {
        return None;
    }
    let minutes = (hours * 60.0).round();
    if minutes <= f64::from(MIN_UPDATE_MINUTES) {
        Some(MIN_UPDATE_MINUTES)
    } else if minutes >= f64::from(MAX_UPDATE_MINUTES) {
        Some(MAX_UPDATE_MINUTES)
    } else {
        Some(minutes as u32)
    }
}

fn parse_web_url(value: &str) -> Option<String> {
    let url = Url::parse(value.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    Some(url.into())
}

fn parse_userinfo(value: &str) -> Option<SubscriptionUserinfo> {
    let mut userinfo = SubscriptionUserinfo::default();
    for part in value.split(';') {
        let Some((key, raw_value)) = part.trim().split_once('=') else {
            continue;
        };
        match key.trim().to_ascii_lowercase().as_str() {
            "upload" => userinfo.upload = raw_value.trim().parse().ok(),
            "download" => userinfo.download = raw_value.trim().parse().ok(),
            "total" => userinfo.total = raw_value.trim().parse().ok(),
            "expire" => {
                userinfo.expire = raw_value
                    .trim()
                    .parse::<i64>()
                    .ok()
                    .and_then(DateTime::<Utc>::from_timestamp_secs)
            }
            _ => {}
        }
    }

    (userinfo != SubscriptionUserinfo::default()).then_some(userinfo)
}
