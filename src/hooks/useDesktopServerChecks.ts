import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { sameSource, type ProfileEvidence, type ProfileSource } from "@/lib/profileEvidence";
import { sameProfileRef, sameSessionIdentity, type DesktopHealthSnapshot, type HealthIssue, type SessionIdentity } from "@/lib/connectionHealth";
import type { ConnectionProfile } from "@/lib/connectionProfiles";
import type { GeneratorSettings, StatusReport } from "@/lib/types";
import type { RowCheck } from "@/components/ServerCheck";
import { useI18n } from "@/lib/i18n";

const issues = new Set<HealthIssue>(["network_unavailable","endpoint_unreachable","timeout","reality_verification","tls_verification","dns","authentication","engine_unavailable","unsupported_probe","probe_target_unavailable","unknown"]);

export function useDesktopServerChecks(profiles: ConnectionProfile[], sources: (ProfileSource|null)[], settings: GeneratorSettings,
  status: StatusReport, snapshot: DesktopHealthSnapshot|null, retry: (identity: SessionIdentity) => Promise<void>,
  activeBusy: boolean, staleMessage: string|null, disabled: boolean) {
  const { t } = useI18n();
  const [pending, setPending] = useState<ProfileSource|null>(null);
  const lock = useRef(false);
  const [results, setResults] = useState<{evidence: ProfileEvidence; issue: HealthIssue|null}[]>([]);
  const latest = useRef({sources, settings}); latest.current = {sources, settings};
  const session = status.status === "running" && snapshot?.session && snapshot.session.run_id === status.run_id ? snapshot.session : null;
  const active = session?.source_revision ? {profile_ref:session.profile_ref,source_revision:session.source_revision} : null;
  const live = snapshot?.health && session && sameSessionIdentity(session, snapshot.health) ? snapshot.health : null;

  async function isolated(source: ProfileSource) {
    if (lock.current) return;
    const index = sources.findIndex(s => sameSource(s, source)), profile = profiles[index];
    if (!profile) return;
    lock.current = true; setPending(source);
    let issue: HealthIssue|null = null;
    let outcome: ProfileEvidence["outcome"] = "unavailable", latency: number|null = null;
    try {
      const health = await api.probeDesktopProfile(source, profile.kind === "manual" ? profile.outbound : null, settings);
      if (!health || !sameProfileRef(health.profile_ref, source.profile_ref) || health.profile_revision !== source.source_revision ||
          health.scope !== "selected_profile" || health.outcome === "cancelled") return;
      outcome = health.outcome === "healthy" ? "passed" : health.outcome === "failed" ? "failed" : "unavailable";
      issue = health.issue;
      latency = health.latency_ms;
    } catch (e) {
      const token = e instanceof Error ? e.message : String(e);
      if (token === "profile_source_changed" || token === "profile_check_cancelled") return;
      issue = issues.has(token as HealthIssue) ? token as HealthIssue : "unknown";
    } finally {
      lock.current = false; setPending(null);
    }
    if (latest.current.settings !== settings || !latest.current.sources.some(s => sameSource(s, source))) return;
    const evidence: ProfileEvidence = {source, scope:"selected_profile", kind:"access", outcome, latency_ms:latency, checked_at:Date.now()};
    setResults(previous => [...previous.filter(item => !sameProfileRef(item.evidence.source.profile_ref,source.profile_ref)).slice(-63), {evidence,issue}]);
  }

  function control(source: ProfileSource): RowCheck {
    const isActive = sameSource(source,active);
    const busy = isActive ? activeBusy || live?.outcome === "checking" : sameSource(source,pending);
    const reason = isActive ? live?.issue : results.find(item => sameSource(source,item.evidence.source))?.issue;
    return {
      busy, disabled: disabled || !!pending || activeBusy || (isActive && (!session || live?.outcome === "checking")),
      message: isActive && staleMessage ? staleMessage : reason ? t("health.reasons."+reason) : null,
      run: () => { if (isActive && session) void retry(session); else void isolated(source); },
    };
  }
  return {control, history:results.map(r=>r.evidence)};
}
