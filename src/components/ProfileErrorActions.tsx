import { Power, RefreshCw } from "lucide-react";
import { Button } from "@/components/Button";
import { useI18n } from "@/lib/i18n";

export interface ProfileErrorActionsProps {
  onReconnect?: () => void;
  onRefresh?: () => void;
  busy?: boolean;
  message?: string | null;
}

export function ProfileErrorActions({ onReconnect, onRefresh, busy, message }: ProfileErrorActionsProps) {
  const { t } = useI18n();
  if (!onReconnect && !onRefresh && !message) return null;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="profile-error-actions">
      {onRefresh && (
        <Button type="button" size="lg" variant="outline" disabled={busy} onClick={onRefresh}>
          <RefreshCw size={16} aria-hidden="true" />{t("profileEvidence.refresh")}
        </Button>
      )}
      {onReconnect && (
        <Button type="button" size="lg" variant="outline" disabled={busy} onClick={onReconnect}>
          <Power size={16} aria-hidden="true" />{t("profileEvidence.reconnect")}
        </Button>
      )}
      {message && <p role="status" className="w-full text-xs text-muted-foreground">{message}</p>}
    </div>
  );
}
