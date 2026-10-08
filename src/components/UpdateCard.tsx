// UpdateCard — UI for backend-verified app-shell updates and core version display.
//
// The app-shell manifest, artifact URL, and minisign signature remain in Rust.
// The WebView receives only version, current version, availability, and notes.
// Sing-box core updates are embedded into Cloakwire releases.

import { useEffect, useState } from "react";
import { Download, RefreshCw, ShieldCheck, Cpu } from "lucide-react";
import { Button } from "./Button";
import { api, TauriCommandError } from "@/lib/api";

interface Props {
  /** Currently-running sing-box version, fetched by App.tsx. */
  currentSingboxVersion: string | null;
  /**
   * Called after sing-box has been updated. Retained for backwards compatibility.
   */
  onSingboxUpdated?: () => void;
}

export function UpdateCard({ currentSingboxVersion }: Props) {
  // App shell (Tauri updater) state.
  const [appUpdate, setAppUpdate] = useState<{
    version: string;
    current_version: string;
    available: boolean;
    notes: string;
  } | null>(null);
  const [appBusy, setAppBusy] = useState(false);
  const [appError, setAppError] = useState<string | null>(null);

  // Auto-check on mount.
  useEffect(() => {
    void checkAppUpdate();
  }, []);

  const checkAppUpdate = async () => {
    setAppError(null);
    try {
      const update = await api.checkAppUpdate();
      setAppUpdate(update.available ? update : null);
    } catch (e) {
      const msg =
        e instanceof TauriCommandError
          ? `${e.kind}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setAppError(msg);
    }
  };

  const installAppUpdate = async () => {
    if (!appUpdate) return;
    setAppBusy(true);
    setAppError(null);
    try {
      await api.installAppUpdate(appUpdate.version);
    } catch (e) {
      const msg =
        e instanceof TauriCommandError
          ? `${e.kind}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setAppError(msg);
    } finally {
      setAppBusy(false);
    }
  };

  return (
    <div className="bento-card rounded-2xl p-5 space-y-4">
      <div className="flex items-start gap-2.5">
        <ShieldCheck size={16} className="mt-0.5 text-theme-accent" />
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">Updates & Core Status</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            App shell updates. VPN cores are managed and bundled with Cloakwire releases.
          </p>
        </div>
      </div>

      <AppUpdateRow
        update={appUpdate}
        busy={appBusy}
        error={appError}
        onCheck={checkAppUpdate}
        onInstall={installAppUpdate}
      />

      <div className="rounded-xl border border-border/80 bg-[#07080c] p-3.5">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="min-w-0">
            <div className="text-[11px] font-mono text-muted-foreground flex items-center gap-1 uppercase">
              <Cpu size={11} className="text-theme-accent" />
              sing-box Core
            </div>
            <div className="text-sm font-medium text-foreground mt-0.5">
              {currentSingboxVersion ? (
                <span className="font-mono">{currentSingboxVersion}</span>
              ) : (
                <span className="text-muted-foreground">not detected</span>
              )}
              <span className="text-muted-foreground ml-2 text-xs font-mono">— managed by Cloakwire release</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- sub-rows -------------------------------------------------------

function AppUpdateRow({
  update,
  busy,
  error,
  onCheck,
  onInstall,
}: {
  update: {
    version: string;
    current_version: string;
    available: boolean;
    notes: string;
  } | null;
  busy: boolean;
  error: string | null;
  onCheck: () => void;
  onInstall: () => void;
}) {
  const available = !!update;
  return (
    <div className="rounded-xl border border-border/80 bg-[#07080c] p-3.5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="text-[11px] font-mono text-muted-foreground uppercase">App Shell</div>
          <div className="text-sm font-medium text-foreground mt-0.5">
            {available ? (
              <>
                New version{" "}
                <span className="font-mono text-theme-accent">{update!.version}</span>{" "}
                available
                {update!.notes ? (
                  <span className="text-xs text-muted-foreground"> — {update!.notes}</span>
                ) : null}
              </>
            ) : error ? (
              <span className="text-muted-foreground">Check failed</span>
            ) : (
              <span className="text-muted-foreground">Up to date</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={onCheck}
            disabled={busy}
            title="Check for app updates"
          >
            <RefreshCw size={12} className={busy ? "animate-spin" : ""} />
          </Button>
          {available && (
            <Button size="sm" onClick={onInstall} disabled={busy} className="bg-theme-accent hover:opacity-90 text-zinc-950 font-medium">
              <Download size={12} className="mr-1" />
              {busy ? "Installing…" : "Update & restart"}
            </Button>
          )}
        </div>
      </div>
      {error && (
        <div className="mt-1.5 text-[11px] text-destructive-foreground/80 font-mono break-all">
          {error}
        </div>
      )}
    </div>
  );
}
