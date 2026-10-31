use super::sources;
use crate::{
    config::{Config, GeneratorSettings},
    parser::Outbound,
};
use serde_json::Value;

pub fn manual_config(
    outbound: &Outbound,
    expected: &str,
    settings: &GeneratorSettings,
) -> Result<(Value, String), &'static str> {
    if sources::revision(outbound) != expected {
        return Err("profile_source_changed");
    }
    let tag = outbound.to_singbox_json()["tag"]
        .as_str()
        .filter(|tag| !tag.is_empty())
        .ok_or("unsupported_probe")?
        .to_owned();
    if matches!(tag.as_str(), "direct" | "block" | "proxy" | "auto") {
        return Err("unsupported_probe");
    }
    let mut config = Config::build(std::slice::from_ref(outbound), settings);
    // Only generated configurations have this known selector. The selected profile is pinned
    // in the throwaway copy; provider configurations are never rewritten by this helper.
    if let Some(servers) = config["dns"]["servers"].as_array_mut() {
        for server in servers {
            if server["detour"] == "proxy" {
                server["detour"] = Value::String(tag.clone());
            }
        }
    }
    Ok((config, tag))
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn run_android_profile_probe(
    app: tauri::AppHandle,
    operation_id: String,
    profile_ref: super::types::ProfileRef,
    source_revision: String,
    outbound: Option<Outbound>,
    settings: GeneratorSettings,
) -> crate::error::AppResult<()> {
    use crate::{
        error::AppError,
        subscriptions::{EngineKind, SubscriptionService},
    };
    use std::sync::Arc;
    use tauri::Manager;
    let error = |token: &str| AppError::Validation(token.into());
    let handle = &app.state::<crate::VpnPluginHandle>().0;
    let _lease = sources::catalog_handoff().await;
    let prepared: crate::error::AppResult<(String, Value, String)> = async {
        // The lease prevents refresh/reorder between source validation and native handoff.
        let service = app.state::<Arc<SubscriptionService>>();
        match &profile_ref {
            super::types::ProfileRef::Manual { .. } => {
                let outbound = outbound.ok_or_else(|| error("unsupported_probe"))?;
                let (config, tag) =
                    manual_config(&outbound, &source_revision, &settings).map_err(error)?;
                Ok(("singbox".into(), config, tag))
            }
            super::types::ProfileRef::Subscription {
                subscription_id,
                link_key,
            } => {
                let index = link_key
                    .strip_prefix("index-")
                    .and_then(|v| v.parse::<usize>().ok())
                    .ok_or_else(|| error("profile_source_changed"))?;
                let entries = service
                    .get_link_outbounds(subscription_id)
                    .await
                    .map_err(|_| error("profile_source_changed"))?;
                let outbound = entries
                    .get(index)
                    .ok_or_else(|| error("profile_source_changed"))?;
                let (config, tag) =
                    manual_config(outbound, &source_revision, &settings).map_err(error)?;
                Ok(("singbox".into(), config, tag))
            }
            super::types::ProfileRef::Ready {
                subscription_id,
                child_key,
            } => {
                let child = service
                    .get_active_child_config(subscription_id, Some(child_key))
                    .await
                    .map_err(|_| error("profile_source_changed"))?;
                sources::require_revision(Some(&source_revision), Some(&child.source_revision))?;
                let config =
                    serde_json::from_str(&child.config).map_err(|_| error("unsupported_probe"))?;
                Ok((
                    match child.engine {
                        EngineKind::Singbox => "singbox",
                        EngineKind::Xray => "xray",
                    }
                    .into(),
                    config,
                    String::new(),
                ))
            }
            _ => Err(error("unsupported_probe")),
        }
    }
    .await;
    let (engine, config, tag) = match prepared {
        Ok(value) => value,
        Err(error) => {
            let _ = handle
                .run_mobile_plugin_async::<Value>(
                    "failProbe",
                    serde_json::json!({"operationId":operation_id}),
                )
                .await;
            return Err(error);
        }
    };
    let source = serde_json::json!({"profile_ref":profile_ref,"source_revision":source_revision});
    handle.run_mobile_plugin_async::<Value>("runProbe",serde_json::json!({
  "operationId":operation_id,"engine":engine,"config":config.to_string(),"tag":tag,"source":source.to_string()
 })).await.map_err(|_|error("profile_check_cancelled"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_pin_is_private_and_preserves_dns_settings() {
        let source = crate::parser::parse_link(
            "vless://00000000-0000-0000-0000-000000000001@192.0.2.1:443?security=none#fixture",
        )
        .unwrap();
        let settings = GeneratorSettings::default();
        let original = Config::build(std::slice::from_ref(&source), &settings);
        let (config, tag) = manual_config(&source, &sources::revision(&source), &settings).unwrap();
        assert_eq!(config["dns"]["servers"][1]["detour"], tag);
        assert_eq!(original["dns"]["servers"][1]["detour"], "proxy");
        assert_eq!(config["dns"]["servers"][0], original["dns"]["servers"][0]);
        assert!(manual_config(&source, "stale", &settings).is_err());
    }
}
