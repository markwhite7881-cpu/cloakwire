import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { GeneratorSettings, Outbound } from "@/lib/types";
import { sameSource, type ProfileSource } from "@/lib/profileEvidence";
import type { RowCheck } from "@/components/ServerCheck";
import { useProfileProbe } from "./useProfileProbe";

export function useServerCardChecks(selected: ProfileSource|null, sources: readonly (ProfileSource|null)[],
  profiles: Outbound[], settings: GeneratorSettings, disabled: boolean) {
  const { t } = useI18n();
  const [request, setRequest] = useState<{source:ProfileSource}|null>(null);
  const target = request ? sources.find(source => sameSource(source,request.source)) ?? null : selected;
  const index = sources.findIndex(source => sameSource(source,target));
  const probe = useProfileProbe(target, profiles[index] ?? null, settings);
  const dispatched = useRef<typeof request>(null);
  useEffect(() => {
    if (!request || dispatched.current === request) return;
    dispatched.current = request;
    if (!disabled && sameSource(request.source,target)) void probe.check().catch(() => {});
  }, [request, target, probe.check, disabled]);

  function control(source: ProfileSource): RowCheck {
    const owns = sameSource(source,target);
    const busy = owns && probe.busy;
    const reason = owns && (probe.health?.issue ?? (probe.error ? "unknown" : null));
    return {
      busy, cancellable:busy, disabled: disabled || (probe.busy && !owns),
      message: reason ? t("health.reasons."+reason) : null,
      run: () => { if (busy) void probe.cancel().catch(() => {}); else setRequest({source}); },
    };
  }
  return {control,evidence:probe.evidence,history:probe.history};
}
