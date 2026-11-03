//! Private additions to the accepted runtime copy; provider storage is untouched.
use super::{
    probe_config::{inject_active_singbox_probe, inject_active_xray_probe},
    types::*,
};
use crate::engine::EngineKind;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    net::{SocketAddr, TcpListener},
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AcceptedSession {
    #[serde(flatten)]
    pub identity: SessionIdentity,
    pub engine: EngineKind,
    pub display_name: Option<String>,
    #[serde(default)]
    pub source_revision: Option<String>,
}
#[derive(Clone)]
pub struct SessionSource {
    profile_ref: ProfileRef,
    name: Option<String>,
    revision: String,
    source_revision: Option<String>,
}
impl SessionSource {
    pub fn new(profile_ref: ProfileRef, name: Option<String>, config: &Value) -> Self {
        Self {
            source_revision: None,
            profile_ref,
            name,
            revision: format!("{:x}", Sha256::digest(config.to_string().as_bytes())),
        }
    }
    pub fn with_source_revision(mut self, revision: String) -> Self {
        self.source_revision = Some(revision);
        self
    }
    pub fn revision(&self) -> &str {
        &self.revision
    }
    pub fn accepted(&self, run_id: &str, engine: EngineKind) -> AcceptedSession {
        AcceptedSession {
            identity: SessionIdentity {
                profile_ref: self.profile_ref.clone(),
                profile_revision: self.revision.clone(),
                run_id: Some(run_id.into()),
                network_generation: uuid::Uuid::new_v4().to_string(),
                effective_outbound_revision: Some(uuid::Uuid::new_v4().to_string()),
            },
            engine,
            display_name: self.name.clone(),
            source_revision: self.source_revision.clone(),
        }
    }
}
#[derive(Clone)]
pub struct ActiveLaunch {
    pub source: SessionSource,
    pub wiring: Option<Arc<ActiveWiring>>,
    reservation: Arc<Mutex<Option<TcpListener>>>,
    original: Option<Arc<Vec<u8>>>,
}
impl ActiveLaunch {
    pub fn unavailable(source: SessionSource) -> Self {
        Self {
            source,
            wiring: None,
            reservation: Arc::new(Mutex::new(None)),
            original: None,
        }
    }
    pub fn prepare(original: &Value, engine: EngineKind, source: SessionSource) -> (Value, Self) {
        let Ok(listener) = TcpListener::bind("127.0.0.1:0") else {
            return (original.clone(), Self::unavailable(source));
        };
        let Ok(address) = listener.local_addr() else {
            return (original.clone(), Self::unavailable(source));
        };
        let password = uuid::Uuid::new_v4().to_string();
        match prepare_active_copy(original, engine, address.port(), &password) {
            Ok(prepared) => (
                prepared.value,
                Self {
                    source,
                    wiring: Some(Arc::new(prepared.wiring)),
                    reservation: Arc::new(Mutex::new(Some(listener))),
                    original: serde_json::to_vec(original).ok().map(Arc::new),
                },
            ),
            Err(_) => (original.clone(), Self::unavailable(source)),
        }
    }
    pub fn release_port(&self) {
        self.reservation
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
    }
    pub(crate) fn restore_original(
        &mut self,
        path: &std::path::Path,
    ) -> crate::error::AppResult<()> {
        let bytes = self.original.as_ref().ok_or_else(|| {
            crate::error::AppError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "missing diagnostic fallback",
            ))
        })?;
        std::fs::write(path, bytes.as_slice()).map_err(crate::error::AppError::Io)?;
        self.disable();
        Ok(())
    }
    pub fn disable(&mut self) {
        self.release_port();
        self.wiring = None;
        self.original = None;
    }
}
pub struct PreparedActive {
    pub value: Value,
    pub wiring: ActiveWiring,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetWitness {
    Matches,
    Changed,
    Unavailable,
}

/// Never Serialize/Debug this type: it contains private runtime credentials.
pub struct ActiveWiring {
    target: String,
    pub(crate) port: u16,
    pub(crate) password: String,
    controller: Option<(String, String)>,
    members: Vec<(String, String)>,
}
impl ActiveWiring {
    pub fn target(&self) -> &str {
        &self.target
    }
    pub fn expected_members(&self) -> Vec<(String, String)> {
        self.members.clone()
    }
    pub async fn matches_current_target(&self) -> bool {
        self.target_witness().await == TargetWitness::Matches
    }
    pub async fn target_witness(&self) -> TargetWitness {
        if self.members.is_empty() {
            return TargetWitness::Matches;
        }
        let Some((url, secret)) = &self.controller else {
            return TargetWitness::Matches;
        }; // no controller and no persistent cache: immutable selectors
        let Ok(client) = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(1))
            .build()
        else {
            return TargetWitness::Unavailable;
        };
        for (group, expected) in &self.members {
            let Ok(mut endpoint) = url::Url::parse(url) else {
                return TargetWitness::Unavailable;
            };
            let Ok(mut segments) = endpoint.path_segments_mut() else {
                return TargetWitness::Unavailable;
            };
            segments.pop_if_empty().push("proxies").push(group);
            drop(segments);
            let mut request = client.get(endpoint);
            if !secret.is_empty() {
                request = request.bearer_auth(secret);
            }
            let Ok(mut response) = request.send().await else {
                return TargetWitness::Unavailable;
            };
            if response.status() != reqwest::StatusCode::OK {
                return TargetWitness::Unavailable;
            }
            let mut body = Vec::new();
            loop {
                match response.chunk().await {
                    Ok(Some(chunk)) => {
                        if body.len() + chunk.len() > 65536 {
                            return TargetWitness::Unavailable;
                        }
                        body.extend_from_slice(&chunk);
                    }
                    Ok(None) => break,
                    Err(_) => return TargetWitness::Unavailable,
                }
            }
            let Ok(value) = serde_json::from_slice::<Value>(&body) else {
                return TargetWitness::Unavailable;
            };
            let Some(current) = value["now"].as_str() else {
                return TargetWitness::Unavailable;
            };
            if current != expected {
                return TargetWitness::Changed;
            }
        }
        TargetWitness::Matches
    }
}
fn proxy(kind: &str) -> bool {
    matches!(
        kind,
        "vless"
            | "vmess"
            | "trojan"
            | "shadowsocks"
            | "socks"
            | "http"
            | "hysteria2"
            | "tuic"
            | "anytls"
            | "shadowtls"
            | "ssh"
    )
}
/// Resolve a fixed sing-box leaf. Both active and isolated probes must reject
/// cached selector state, urltest groups, missing members and selector cycles.
pub(super) fn singbox_target(
    original: &Value,
    initial: &str,
    members: &mut Vec<(String, String)>,
) -> Result<String, HealthIssue> {
    let unsupported = HealthIssue::UnsupportedProbe;
    let list = original["outbounds"].as_array().ok_or(unsupported)?;
    let mut tag = initial.to_owned();
    let mut visited = std::collections::HashSet::new();
    loop {
        if !visited.insert(tag.clone()) || visited.len() > 16 {
            return Err(unsupported);
        }
        let entry = list
            .iter()
            .find(|v| v["tag"].as_str() == Some(&tag))
            .ok_or(unsupported)?;
        let kind = entry["type"].as_str().ok_or(unsupported)?;
        if proxy(kind) {
            break Ok(tag);
        }
        if kind != "selector" {
            return Err(unsupported);
        }
        if original["experimental"]["cache_file"]["enabled"] == true {
            return Err(unsupported);
        }
        let available = entry["outbounds"].as_array().ok_or(unsupported)?;
        let selected = entry["default"]
            .as_str()
            .or_else(|| available.first().and_then(Value::as_str))
            .ok_or(unsupported)?;
        if !available.iter().any(|v| v.as_str() == Some(selected)) {
            return Err(unsupported);
        }
        members.push((tag.clone(), selected.to_owned()));
        tag = selected.into();
    }
}
pub fn prepare_active_copy(
    original: &Value,
    engine: EngineKind,
    port: u16,
    password: &str,
) -> Result<PreparedActive, HealthIssue> {
    let unsupported = HealthIssue::UnsupportedProbe;
    let list = original["outbounds"].as_array().ok_or(unsupported)?;
    let mut members = Vec::new();
    let mut controller = None;
    let target = match engine {
        EngineKind::Singbox => {
            let clash = &original["experimental"]["clash_api"];
            if let Some(address) = clash["external_controller"]
                .as_str()
                .filter(|s| !s.is_empty())
            {
                let socket = address.parse::<SocketAddr>().map_err(|_| unsupported)?;
                if !socket.ip().is_loopback() || socket.port() == 0 {
                    return Err(unsupported);
                }
                controller = Some((
                    format!("http://{socket}"),
                    clash["secret"].as_str().unwrap_or("").to_owned(),
                ));
            }
            let initial = original["route"]["final"].as_str().ok_or(unsupported)?;
            singbox_target(original, initial, &mut members)?
        }
        EngineKind::Xray => {
            if original["routing"]["balancers"]
                .as_array()
                .is_some_and(|v| !v.is_empty())
            {
                return Err(unsupported);
            }
            let proxies: Vec<_> = list
                .iter()
                .filter(|v| v["protocol"].as_str().is_some_and(proxy))
                .collect();
            if proxies.len() != 1 || list.first() != proxies.first().copied() {
                return Err(unsupported);
            }
            proxies[0]["tag"].as_str().ok_or(unsupported)?.to_owned()
        }
    };
    let value = match engine {
        EngineKind::Singbox => inject_active_singbox_probe(original, &target, port, password)?,
        EngineKind::Xray => inject_active_xray_probe(original, &target, port, password)?,
    };
    Ok(PreparedActive {
        value,
        wiring: ActiveWiring {
            target,
            port,
            password: password.into(),
            controller,
            members,
        },
    })
}

/// The caller has already preflighted the original. Optional diagnostic wiring
/// may not turn a valid provider profile into a rejected connection.
pub async fn attach_checked_copy<F, Fut>(
    path: &std::path::Path,
    engine: EngineKind,
    source: SessionSource,
    validate: F,
) -> crate::error::AppResult<ActiveLaunch>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = crate::error::AppResult<()>>,
{
    attach_checked_copy_with_writer(path, engine, source, validate, |path, bytes| {
        std::fs::write(path, bytes)
    })
    .await
}
pub(crate) async fn attach_checked_copy_with_writer<F, Fut, W>(
    path: &std::path::Path,
    engine: EngineKind,
    source: SessionSource,
    validate: F,
    mut write: W,
) -> crate::error::AppResult<ActiveLaunch>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = crate::error::AppResult<()>>,
    W: FnMut(&std::path::Path, &[u8]) -> std::io::Result<()>,
{
    let original = std::fs::read(path).map_err(crate::error::AppError::Io)?;
    let value: Value = serde_json::from_slice(&original).map_err(crate::error::AppError::Serde)?;
    let (copy, mut launch) = ActiveLaunch::prepare(&value, engine, source);
    if launch.wiring.is_none() {
        return Ok(launch);
    }
    launch.original = Some(Arc::new(original.clone()));
    let bytes = serde_json::to_vec(&copy).map_err(crate::error::AppError::Serde)?;
    if write(path, &bytes).is_err() {
        write(path, &original).map_err(crate::error::AppError::Io)?;
        launch.disable();
        return Ok(launch);
    }
    if validate().await.is_err() {
        write(path, &original).map_err(crate::error::AppError::Io)?;
        launch.disable();
    }
    Ok(launch)
}
