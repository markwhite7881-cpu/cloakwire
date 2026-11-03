import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound, Loader2, RefreshCw, Save, X } from "lucide-react";
import { api } from "@/lib/api";
import type { DeviceHwidInfo } from "@/lib/types";
import { Button } from "@/components/Button";
import { Badge } from "@/components/Badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/Card";
import { useI18n } from "@/lib/i18n";

export function SubscriptionIdentityCard() {
  const { t } = useI18n();
  const [info, setInfo] = useState<DeviceHwidInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setInfo(await api.getSubscriptionHwid());
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async () => {
    const value = draft.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      setInfo(await api.setSubscriptionHwid(value));
      setDraft("");
      setEditing(false);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!window.confirm(t("servers.clearOverrideConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      setInfo(await api.setSubscriptionHwid(null));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const resetAuto = async () => {
    if (!window.confirm(t("servers.regenerateAutoHwidConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      setInfo(await api.resetSubscriptionHwid());
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!info?.effective) return;
    try {
      await navigator.clipboard.writeText(info.effective);
      setError(null);
    } catch {
      setError(t("servers.identityClipboardUnavailable"));
    }
  };

  return (
    <Card className="atlas-section">
      <CardHeader>
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-theme-accent" />
            {t("servers.subscriptionIdentityTitle")}
            {info?.custom && <Badge variant="secondary">{t("servers.customBadge")}</Badge>}
          </CardTitle>
          <CardDescription>
            {t("servers.subscriptionIdentityDesc")}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <p className="text-[10px] text-muted-foreground">{t("servers.effectiveHwid")}</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded border border-border bg-muted/40 px-2 py-1.5 font-mono text-[11px]">
              {loading ? t("common.loading") : info?.effective ?? t("common.unknown")}
            </code>
            <Button variant="outline" size="sm" onClick={() => void copy()} disabled={!info?.effective || busy}>
              <Copy className="h-3.5 w-3.5" /> {t("common.copy")}
            </Button>
          </div>
        </div>

        {info?.custom && (
          <p className="text-[11px] text-muted-foreground">
            {t("servers.overrideActiveAuto", { auto: info.auto ?? "—" })}
          </p>
        )}

        {editing ? (
          <div className="space-y-2 rounded border border-border bg-card/40 p-3">
            <input
              type="text"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setError(null);
              }}
              placeholder="xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"
              spellCheck={false}
              autoComplete="off"
              className="atlas-input w-full font-mono"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setDraft(""); }} disabled={busy}>
                <X className="h-3.5 w-3.5" /> {t("common.cancel")}
              </Button>
              <Button size="sm" onClick={() => void save()} disabled={busy || !draft.trim()}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                {t("servers.saveOverride")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => { setDraft(info?.custom ?? ""); setEditing(true); }} disabled={busy || loading}>
              {t("servers.pasteHwidOverride")}
            </Button>
            {info?.custom && (
              <Button variant="ghost" size="sm" onClick={() => void clear()} disabled={busy}>
                {t("servers.clearOverride")}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => void resetAuto()} disabled={busy || loading}>
              <RefreshCw className="h-3.5 w-3.5" /> {t("servers.regenerateAutoHwid")}
            </Button>
          </div>
        )}

        {error && <p className="rounded border border-destructive/30 bg-destructive/10 p-2 text-[11px] text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : "Subscription identity operation failed";
}
