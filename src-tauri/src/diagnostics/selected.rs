use super::{
    active_config::singbox_target,
    android_probe::manual_config,
    coordinator::ProbeCoordinator,
    desktop::{ensure_isolation_available, DesktopProbe, DesktopProbeRequest},
    network, network_events, sources,
    types::{
        ConnectionHealth, HealthIssue, HealthOutcome, HealthScope, ProfileRef, SessionIdentity,
    },
};
use crate::{
    config::GeneratorSettings,
    parser::Outbound,
    process::ProcessManager,
    subscriptions::{EngineKind, SubscriptionLinkRef, SubscriptionService},
};
use serde::Serialize;
use serde_json::Value;
use std::sync::{Arc, Mutex};

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SelectedProbeError {
    ProfileSourceChanged,
    ProfileCheckCancelled,
    #[serde(untagged)]
    Health(HealthIssue),
}
impl From<HealthIssue> for SelectedProbeError {
    fn from(issue: HealthIssue) -> Self {
        Self::Health(issue)
    }
}

pub(super) fn ready_target(config: &Value) -> Result<String, HealthIssue> {
    // sing-box's implicit final outbound is the first configured entry.
    let initial = match config["route"].get("final") {
        None | Some(Value::Null) => config["outbounds"][0]["tag"].as_str(),
        Some(value) => value.as_str(),
    }
    .ok_or(HealthIssue::UnsupportedProbe)?;
    singbox_target(config, initial, &mut Vec::new())
}

pub(super) async fn resolve_profile(
    service: &SubscriptionService,
    reference: &ProfileRef,
    revision: &str,
    manual: Option<&Outbound>,
    settings: &GeneratorSettings,
) -> Result<(Value, String), SelectedProbeError> {
    let stored;
    let outbound = match reference {
        ProfileRef::Manual { id } if !id.is_empty() && id.len() <= 128 => {
            manual.ok_or(HealthIssue::UnsupportedProbe)?
        }
        ProfileRef::Subscription {
            subscription_id,
            link_key,
        } => {
            stored = service
                .resolve_link_refs(&[SubscriptionLinkRef {
                    subscription_id: subscription_id.clone(),
                    link_key: link_key.clone(),
                }])
                .await
                .map_err(|_| SelectedProbeError::ProfileSourceChanged)?;
            stored
                .first()
                .ok_or(SelectedProbeError::ProfileSourceChanged)?
        }
        ProfileRef::Ready {
            subscription_id,
            child_key,
        } => {
            let child = service
                .resolve_child_profile(subscription_id, child_key)
                .await
                .map_err(|_| SelectedProbeError::ProfileSourceChanged)?;
            if sources::ready_revision(child.engine, &child.config) != revision {
                return Err(SelectedProbeError::ProfileSourceChanged);
            }
            ensure_isolation_available(child.engine)?;
            let tag = ready_target(&child.config)?;
            return Ok((child.config, tag));
        }
        _ => return Err(HealthIssue::UnsupportedProbe.into()),
    };
    let (mut config, tag) =
        manual_config(outbound, revision, settings).map_err(|code| match code {
            "profile_source_changed" => SelectedProbeError::ProfileSourceChanged,
            _ => HealthIssue::UnsupportedProbe.into(),
        })?;
    // Config::build adds an HTTP client for rule-set downloads. The isolated
    // route drops rule sets and never needs this generated network client.
    config
        .as_object_mut()
        .ok_or(HealthIssue::UnsupportedProbe)?
        .remove("http_clients");
    Ok((config, tag))
}

#[derive(Default)]
pub struct SelectedProbes {
    // Active-session retries have their own coordinator. Checking a different server
    // cannot cancel a live-session health check or publish into its health slot.
    pub coordinator: ProbeCoordinator,
    admission: tokio::sync::Mutex<()>,
    catalog_owner: Mutex<Option<(String, u64)>>,
}
impl SelectedProbes {
    pub fn snapshot(&self) -> Option<ConnectionHealth> {
        let health = self.coordinator.snapshot().selected_profile?;
        let owner = self.catalog_owner.lock().unwrap_or_else(|p| p.into_inner());
        let current = owner.as_ref().is_some_and(|(id, epoch)| {
            *id == health.operation_id && *epoch == sources::catalog_epoch()
        }) && network_events::generation()
            .is_some_and(|epoch| epoch.to_string() == health.identity.network_generation);
        current.then_some(health)
    }
}

#[tauri::command]
pub async fn probe_desktop_profile(
    app: tauri::AppHandle,
    pm: tauri::State<'_, Arc<ProcessManager>>,
    probes: tauri::State<'_, SelectedProbes>,
    subscriptions: tauri::State<'_, Arc<SubscriptionService>>,
    profile_ref: ProfileRef,
    source_revision: String,
    outbound: Option<Outbound>,
    settings: GeneratorSettings,
) -> Result<ConnectionHealth, SelectedProbeError> {
    let _admission = probes.admission.lock().await;
    // The active row is checked via retry_active_probe against its existing core.
    let selected_is_active = || {
        let active = pm.diagnostics.snapshot();
        !active.ended_unexpectedly
            && active.session.is_some_and(|session| {
                session.identity.profile_ref == profile_ref
                    && session.source_revision.as_deref() == Some(source_revision.as_str())
            })
    };
    if selected_is_active() {
        return Err(SelectedProbeError::ProfileCheckCancelled);
    }
    let (config, tag, catalog) = {
        let _handoff = sources::catalog_handoff().await;
        let (config, tag) = resolve_profile(
            &subscriptions,
            &profile_ref,
            &source_revision,
            outbound.as_ref(),
            &settings,
        )
        .await?;
        (config, tag, sources::catalog_epoch())
    };
    let epoch = network_events::generation().ok_or(HealthIssue::NetworkUnavailable)?;
    let physical = network::discover().await?;
    let identity = SessionIdentity {
        profile_ref: profile_ref.clone(),
        profile_revision: source_revision.clone(),
        run_id: None,
        network_generation: epoch.to_string(),
        effective_outbound_revision: Some(sources::revision(&(tag.as_str(), &config))),
    };
    let request =
        DesktopProbeRequest::from_resolved(&app, EngineKind::Singbox, config, tag, physical)?;
    if catalog != sources::catalog_epoch() {
        return Err(SelectedProbeError::ProfileSourceChanged);
    }
    if Some(epoch) != network_events::generation() {
        return Err(HealthIssue::NetworkUnavailable.into());
    }
    let begin = probes
        .coordinator
        .begin(identity, HealthScope::SelectedProfile);
    let lease = begin
        .lease
        .ok_or(SelectedProbeError::ProfileCheckCancelled)?;
    *probes
        .catalog_owner
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = Some((begin.operation_id.clone(), catalog));
    DesktopProbe::execute(&probes.coordinator, lease, request).await;
    if selected_is_active() {
        probes.coordinator.invalidate();
        return Err(SelectedProbeError::ProfileCheckCancelled);
    }
    if catalog != sources::catalog_epoch() {
        return Err(SelectedProbeError::ProfileSourceChanged);
    }
    if Some(epoch) != network_events::generation() {
        return Err(HealthIssue::NetworkUnavailable.into());
    }
    probes
        .snapshot()
        .filter(|health| {
            health.operation_id == begin.operation_id && health.outcome != HealthOutcome::Cancelled
        })
        .ok_or(SelectedProbeError::ProfileCheckCancelled)
}
