import { createContext, useContext } from "react";
import { RefreshCw, X } from "lucide-react";
import { ProfileHealthContext } from "./ProfileHealthBadge";
import { sameProfileRef, type ProfileRef } from "@/lib/connectionHealth";
import type { ProfileSource } from "@/lib/profileEvidence";
import { useI18n } from "@/lib/i18n";

export interface RowCheck {
  busy: boolean;
  disabled: boolean;
  cancellable?: boolean;
  message?: string | null;
  run: () => void;
}

export const ServerCheckContext = createContext<((source: ProfileSource) => RowCheck) | null>(null);

export function ServerCheck({ profileRef, profileIndex }: {profileRef?: ProfileRef | null; profileIndex?: number}) {
  const control = useContext(ServerCheckContext);
  const { sources } = useContext(ProfileHealthContext);
  if (!control) return null;
  const source = profileRef ? sources.find(s => s && sameProfileRef(s.profile_ref, profileRef)) :
    profileIndex != null ? sources[profileIndex] : null;
  return <ServerCheckButton check={source ? control(source) : null} />;
}

export function ServerCheckButton({check, activeSession = false}: {check: RowCheck | null; activeSession?: boolean}) {
  const { t } = useI18n();
  const label = t(check?.cancellable ? "profileProbe.cancel" : check?.busy ? "health.checking" :
    activeSession ? "health.checkConnection" : "profileProbe.check");
  return <div className="atlas-server-check" data-testid="profile-probe-card">
    <button type="button" className="atlas-button" data-size="icon" data-variant="ghost" data-testid="profile-probe-button"
      aria-label={label} title={label} disabled={!check || check.disabled} onClick={check?.run}>
      {check?.cancellable ? <X size={15} aria-hidden="true"/> : <RefreshCw size={15} aria-hidden="true" className={check?.busy ? "animate-spin motion-reduce:animate-none" : ""}/>}
    </button>
    {check?.message && <span role="status" className="atlas-check-message">{check.message}</span>}
  </div>;
}
