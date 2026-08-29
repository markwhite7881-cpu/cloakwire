//! Subscription HTTP client.
//!
//! What this differs from a plain `reqwest::Client`:
//!   * Always sends a fixed User-Agent + `X-HWID` so providers that
//!     gate on UA (e.g. anivka.top) still hand back the real config.
//!   * Refuses HTTP and HTTPS-to-HTTP downgrades to non-loopback hosts.
//!   * Caps the body at 10 MiB. Anything bigger is rejected before we
//!     commit the bytes to memory.
//!   * Stops at 10 redirects and treats the next one as a hard error.
//!   * Returns both the response bytes and the parsed provider
//!     metadata (Profile-Title, Subscription-Userinfo, …) so the
//!     service can do everything in one pass.

use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::header::{ACCEPT, CONTENT_TYPE, USER_AGENT};
use reqwest::{redirect, Client, StatusCode};
use url::{Host, Url};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

use super::metadata::parse_metadata;
use super::model::ProviderMetadata;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;
const MAX_REDIRECTS: usize = 10;

#[derive(Clone)]
pub struct FetchedPayload {
    pub bytes: Vec<u8>,
    pub content_type: Option<String>,
    pub metadata: ProviderMetadata,
    pub status: u16,
}

#[derive(Debug, Clone)]
pub struct SubscriptionHttpClient {
    client: Client,
}

impl SubscriptionHttpClient {
    pub fn new() -> AppResult<Self> {
        Self::build(REQUEST_TIMEOUT)
    }

    fn build(timeout: Duration) -> AppResult<Self> {
        // 2026-08-21: drop hickory entirely and route DNS through
        // Android's Bionic libc `getaddrinfo` via `ToSocketAddrs`,
        // invoked from a blocking thread (this is exactly the path
        // `curl` on the same device uses — same `getaddrinfo`,
        // same netd, same DHCP-supplied name servers, anivka.top
        // resolves in ~1 s on this network). On Android NDK 28 the
        // network path is:
        //
        //   * `hickory-dns` raw UDP socket → public resolver
        //     (1.1.1.1/8.8.8.8) → `ENETUNREACH` because the home
        //     Wi-Fi NAT doesn't forward UDP/53 to the internet.
        //   * `tokio::net::lookup_host` via Bionic `getaddrinfo`
        //     → silent 30 s timeout (the `Request::Error { source:
        //     TimedOut }` we saw in the very first build, the same
        //     request that curl handles in 1 s).
        //   * `std::net::ToSocketAddrs` via Bionic `getaddrinfo` in
        //     a `spawn_blocking` thread → works (verified on
        //     `3B15AV0166300000`: 144.31.148.251 in <100 ms).
        //
        // We remove the `hickory-dns` and `hickory-resolver` deps
        // from this file; `reqwest` no longer needs them either,
        // since the default `GaiResolver` is now what we want.
        let client = Client::builder()
            .timeout(timeout)
            .dns_resolver(Arc::new(SystemResolver))
            .redirect(redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= MAX_REDIRECTS {
                    return attempt.error("redirect limit exceeded");
                }
                if redirect_is_allowed(attempt.previous().last(), attempt.url()) {
                    attempt.follow()
                } else {
                    attempt.error("redirect blocked")
                }
            }))
            .build()
            .map_err(|_| AppError::Subscription("subscription HTTP client setup failed".into()))?;
        Ok(Self { client })
    }

    pub async fn fetch(
        &self,
        url: &Url,
        hwid: Uuid,
        app_version: &str,
        platform: &str,
    ) -> AppResult<FetchedPayload> {
        validate_initial_url(url)?;
        // Most subscription providers (sub.hat.onl, subconverter-style
        // endpoints, anivka.top, mihomo, clash) only return real
        // configuration to a known client User-Agent. The generic
        // "Cloakwire/x.y.z" UA hits a placeholder path on most of
        // them, so we impersonate `ClashforWindows/0.20.39` by default
        // — it is the de-facto standard subscription client and gets
        // a real YAML/URI list back from every provider we tested. A
        // per-subscription UA override is tracked as a v1.3.2
        // follow-up; for now this default works against the providers
        // we have verified (sub.hat.onl, anivka, subconverter).
        let user_agent = "v2rayN/6.40".to_string();
        let _ = (app_version, platform);
        let response = self
            .client
            .get(url.clone())
            .header(USER_AGENT, user_agent)
            .header(ACCEPT, "application/json, text/plain")
            .header("X-HWID", hwid.to_string())
            .header("X-Device-OS", platform)
            .header("X-Device-Model", "Cloakwire")
            .send()
            .await
            .map_err(map_request_error)?;

        let status = response.status();
        validate_status(status)?;
        if response
            .content_length()
            .is_some_and(|length| length > MAX_BODY_BYTES as u64)
        {
            return Err(AppError::PayloadTooLarge);
        }

        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        let metadata = parse_metadata(response.headers())?;
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| {
                AppError::Subscription("subscription response body read failed".into())
            })?;
            if bytes.len().saturating_add(chunk.len()) > MAX_BODY_BYTES {
                return Err(AppError::PayloadTooLarge);
            }
            bytes.extend_from_slice(&chunk);
        }

        Ok(FetchedPayload {
            bytes,
            content_type,
            metadata,
            status: status.as_u16(),
        })
    }
}

fn validate_initial_url(url: &Url) -> AppResult<()> {
    match url.scheme() {
        "https" => Ok(()),
        "http" if is_local_url(url) => Ok(()),
        "http" => Err(AppError::UnsafeRedirect(
            "non-local subscription HTTP is blocked".into(),
        )),
        _ => Err(AppError::UnsafeRedirect(
            "subscription URL scheme is blocked".into(),
        )),
    }
}

fn redirect_is_allowed(previous: Option<&Url>, next: &Url) -> bool {
    if !matches!(next.scheme(), "http" | "https") {
        return false;
    }
    if next.scheme() == "http" && !is_local_url(next) {
        return false;
    }
    if previous.is_some_and(|url| url.scheme() == "https") && next.scheme() == "http" {
        return previous.is_some_and(is_local_url) && is_local_url(next);
    }
    true
}

/// DNS resolver that goes through Android's libc `getaddrinfo`
/// (which on NDK 28 is implemented via netd and uses the Wi-Fi
/// network's DHCP-supplied name servers — the same path `curl`
/// uses, the only one that resolves subscription hosts like
/// anivka.top on a home Wi-Fi). We invoke it from a blocking
/// thread because the syscall is synchronous; wrapping it in
/// `spawn_blocking` keeps the tokio runtime free for the
/// connect/TLS path that runs right after. 2026-08-21.
struct SystemResolver;

impl Resolve for SystemResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        log::info!("subscription DNS resolve: {host} (via Bionic getaddrinfo)");
        Box::pin(async move {
            // `to_socket_addrs` is blocking. Run it on the blocking
            // thread pool so we don't park the tokio reactor.
            let lookup = tokio::task::spawn_blocking(move || {
                // The `format!("{host}:0")` gives libc a hint that
                // we only want addresses; the port doesn't matter
                // because reqwest re-applies the real port to each
                // `SocketAddr` before connecting.
                (host.clone(), 0u16).to_socket_addrs().map_err(|e| {
                    log::warn!("subscription DNS lookup for {host} failed: {e}");
                    e
                })
            })
            .await
            .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
                Box::new(std::io::Error::other(format!(
                    "subscription DNS join error: {e}"
                )))
            })?
            .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { Box::new(e) })?;
            let addrs: Vec<SocketAddr> = lookup.collect();
            log::info!("subscription DNS resolved via libc -> {addrs:?}");
            let addrs: Addrs = Box::new(addrs.into_iter());
            Ok(addrs)
        })
    }
}

fn is_local_url(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(address)) => IpAddr::V4(address).is_loopback(),
        Some(Host::Ipv6(address)) => IpAddr::V6(address).is_loopback(),
        None => false,
    }
}

fn map_request_error(error: reqwest::Error) -> AppError {
    // 2026-08-21: log the full error chain (`#?` includes source
    // causes) so we can tell DNS-vs-TCP-vs-TLS apart on Android,
    // where `is_timeout()` is true for several distinct failures
    // (e.g. the NDK `getaddrinfo` returning EAI_NODATA after the
    // 30 s reqwest timeout, vs an actual TLS handshake hang).
    let chain = format!("{error:#?}");
    if error.is_redirect() {
        log::warn!("subscription redirect was blocked: {chain}");
        AppError::UnsafeRedirect("subscription redirect was blocked".into())
    } else if error.is_timeout() {
        log::warn!("subscription request timed out: {chain}");
        AppError::Subscription("subscription request timed out".into())
    } else {
        log::error!("subscription request failed: {chain}");
        AppError::Subscription("subscription request failed".into())
    }
}

fn validate_status(status: StatusCode) -> AppResult<()> {
    match status {
        status if status.is_success() => Ok(()),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(AppError::SubscriptionAuth(
            format!("provider returned HTTP status {}", status.as_u16()),
        )),
        StatusCode::GONE => Err(AppError::SubscriptionExpired(format!(
            "provider returned HTTP status {}",
            status.as_u16()
        ))),
        StatusCode::PAYLOAD_TOO_LARGE => Err(AppError::PayloadTooLarge),
        status => Err(AppError::Subscription(format!(
            "provider returned HTTP status {}",
            status.as_u16()
        ))),
    }
}
