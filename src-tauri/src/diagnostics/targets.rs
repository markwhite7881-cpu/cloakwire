//! Fixed HTTPS targets through an explicit authenticated loopback proxy.
//! No OS/environment proxy, redirect, certificate bypass, body or IP in the result.
use super::{probe_config::PROBE_USER, types::HealthIssue};
use std::{net::IpAddr, time::Duration};
use tokio::time::Instant;

const MAX_TRACE_BYTES: usize = 4096;
pub struct TargetSet {
    primary: String,
    fallback: String,
}
impl Default for TargetSet {
    fn default() -> Self {
        Self {
            primary: "https://www.gstatic.com/generate_204".into(),
            fallback: "https://www.cloudflare.com/cdn-cgi/trace".into(),
        }
    }
}
impl TargetSet {
    #[cfg(test)]
    pub(crate) fn only_loopback_fixture(&self) -> bool {
        [&self.primary, &self.fallback].iter().all(|s| {
            url::Url::parse(s)
                .is_ok_and(|u| u.scheme() == "http" && u.host_str() == Some("127.0.0.1"))
        })
    }
    #[cfg(test)]
    pub(crate) fn fixture(primary: &str, fallback: &str) -> Self {
        Self {
            primary: primary.into(),
            fallback: fallback.into(),
        }
    }
}
pub struct ProbeClient {
    client: reqwest::Client,
}
impl ProbeClient {
    pub fn new(port: u16, password: &str) -> Result<Self, HealthIssue> {
        if port == 0 || password.is_empty() {
            return Err(HealthIssue::UnsupportedProbe);
        }
        let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{port}"))
            .map_err(|_| HealthIssue::EngineUnavailable)?
            .basic_auth(PROBE_USER, password);
        let client = reqwest::Client::builder()
            .no_proxy()
            .proxy(proxy)
            .redirect(reqwest::redirect::Policy::none())
            .http1_only()
            .pool_max_idle_per_host(0)
            .timeout(Duration::from_secs(4))
            .build()
            .map_err(|_| HealthIssue::EngineUnavailable)?;
        Ok(Self { client })
    }
    pub async fn check(&self, targets: &TargetSet) -> Result<u64, HealthIssue> {
        let started = Instant::now();
        if let Ok(response) = self.client.get(&targets.primary).send().await {
            if response.status() == reqwest::StatusCode::NO_CONTENT {
                return Ok(started.elapsed().as_millis() as u64);
            }
        }
        let started = Instant::now();
        if let Ok(mut response) = self.client.get(&targets.fallback).send().await {
            if response.status() != reqwest::StatusCode::OK
                || response
                    .content_length()
                    .is_some_and(|n| n > MAX_TRACE_BYTES as u64)
            {
                return Err(HealthIssue::ProbeTargetUnavailable);
            }
            let mut body = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| HealthIssue::ProbeTargetUnavailable)?
            {
                if body.len() + chunk.len() > MAX_TRACE_BYTES {
                    return Err(HealthIssue::ProbeTargetUnavailable);
                }
                body.extend_from_slice(&chunk);
            }
            if valid_trace(&body) {
                return Ok(started.elapsed().as_millis() as u64);
            }
        }
        Err(HealthIssue::ProbeTargetUnavailable)
    }
}

pub(crate) fn valid_trace(body: &[u8]) -> bool {
    if body.len() > MAX_TRACE_BYTES {
        return false;
    }
    let Ok(body) = std::str::from_utf8(body) else {
        return false;
    };
    let mut fields = std::collections::HashMap::new();
    for line in body.lines() {
        let Some((key, value)) = line.split_once('=') else {
            return false;
        };
        if fields.insert(key, value).is_some() {
            return false;
        }
    }
    fields.get("h") == Some(&"www.cloudflare.com")
        && fields.get("visit_scheme") == Some(&"https")
        && fields
            .get("ip")
            .is_some_and(|ip| ip.parse::<IpAddr>().is_ok())
        && fields
            .get("ts")
            .and_then(|ts| ts.parse::<f64>().ok())
            .is_some_and(|ts| ts.is_finite() && ts > 0.0)
        && fields
            .get("tls")
            .is_some_and(|tls| tls.starts_with("TLSv1."))
}
