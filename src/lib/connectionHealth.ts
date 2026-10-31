export type ProfileRef =
  | { kind: "manual"; id: string }
  | { kind: "subscription"; subscription_id: string; link_key: string }
  | { kind: "ready"; subscription_id: string; child_key: string }
  | { kind: "auto"; snapshot_id: string };

export interface SessionIdentity {
  profile_ref: ProfileRef;
  profile_revision: string;
  run_id: string | null;
  network_generation: string;
  effective_outbound_revision: string | null;
}
export type HealthScope = "selected_profile" | "active_session";
export type HealthStage = "preparing" | "connecting" | "verifying" | "complete";
export type HealthOutcome = "unknown" | "checking" | "healthy" | "failed" | "unavailable" | "cancelled";
export type HealthIssue = "network_unavailable" | "endpoint_unreachable" | "timeout" |
  "reality_verification" | "tls_verification" | "dns" | "authentication" |
  "engine_unavailable" | "unsupported_probe" | "probe_target_unavailable" | "unknown";
export interface ConnectionHealth extends SessionIdentity {
  operation_id: string;
  scope: HealthScope;
  stage: HealthStage;
  outcome: HealthOutcome;
  issue: HealthIssue | null;
  checked_at: string | null;
  latency_ms: number | null;
}
export interface HealthSnapshot {
  selected_profile: ConnectionHealth | null;
  active_session: ConnectionHealth | null;
}

export function sameProfileRef(a: ProfileRef, b: ProfileRef): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "manual": return b.kind === "manual" && a.id === b.id;
    case "subscription": return b.kind === "subscription" && a.subscription_id === b.subscription_id && a.link_key === b.link_key;
    case "ready": return b.kind === "ready" && a.subscription_id === b.subscription_id && a.child_key === b.child_key;
    case "auto": return b.kind === "auto" && a.snapshot_id === b.snapshot_id;
  }
}
export function sameSessionIdentity(a: SessionIdentity, b: SessionIdentity): boolean {
  return sameProfileRef(a.profile_ref, b.profile_ref) && a.profile_revision === b.profile_revision &&
    a.run_id === b.run_id && a.network_generation === b.network_generation &&
    a.effective_outbound_revision === b.effective_outbound_revision;
}

/** The caller owns expected identity AND operation; an old retry of the same
 * profile must not overwrite the current result. Stop clears both expectations. */
export function applyHealthEvent(
  current: ConnectionHealth | null, event: ConnectionHealth,
  expected: SessionIdentity | null, operationId: string | null,
  scope: HealthScope = event.scope,
): ConnectionHealth | null {
  if (!expected || !operationId || event.operation_id !== operationId ||
    event.scope !== scope || !sameSessionIdentity(event, expected)) return current;
  return event;
}
export function isHealthFresh(health: ConnectionHealth | null, expected: SessionIdentity, now: number): boolean {
  if (!health || !sameSessionIdentity(health, expected) || !health.checked_at ||
    !["healthy", "failed", "unavailable"].includes(health.outcome)) return false;
  const age = now - Date.parse(health.checked_at);
  return Number.isFinite(age) && age >= 0 && age < 60000;
}

export interface AcceptedSession extends SessionIdentity {
  source_revision?: string|null;
  engine: "singbox" | "xray";
  display_name: string | null;
}
export interface RuntimeIssue {
  run_id: string; code: HealthIssue; severity: "notice" | "connection";
  count: number; observed_at: string;
}
export interface DesktopHealthSnapshot {
  session: AcceptedSession | null;
  health: ConnectionHealth | null;
  issue: RuntimeIssue | null;
  ended_unexpectedly: boolean;
}
