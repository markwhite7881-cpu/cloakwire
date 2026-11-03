// ProcessPicker — small inline panel that lists currently-running
// processes so the user can pick a .exe to add to a routing rule's
// `process_name` matcher.
//
// UI shape:
//   - Toggle button: "Pick from running…"  /  "Hide"
//   - When open: a search box + a scrollable list of processes.
//   - Click a row → toggle its name in the rule's `process_name` array.
//     A small badge on the right shows whether it's already selected.
//
// Behaviour:
//   - Fetches via `api.listProcesses()` on first open; refreshes
//     when the user clicks the refresh icon.
//   - Outside the Tauri shell (vite dev preview) the list is empty
//     and a hint is shown — we don't try to read the browser's
//     process list (it can't, and shouldn't).
//   - Already-selected processes are de-duplicated against the
//     `selected` array (case-insensitive). The list still shows them
//     so the user can see what's already in the rule.

import { useEffect, useMemo, useState } from "react";
import { FilePlus2, ListChecks, Loader2, RefreshCw, X } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "../Button";
import { api, TauriCommandError } from "@/lib/api";
import type { ProcessInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

interface Props {
  /** Currently selected process names (the rule's `process_name` array). */
  selected: string[];
  /** Called with the next value of the array. */
  onChange: (next: string[]) => void;
  /**
   * If true, the picker is fully read-only: the toggle button is
   * disabled, the search box is disabled, and clicks on process
   * rows do nothing. Used when routing cannot apply (e.g. the
   * user is in system-proxy / no-TUN mode).
   */
  disabled?: boolean;
}

const SELECTED_KEY = (n: string) => n.toLowerCase();

export function ProcessPicker({ selected, onChange, disabled }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const selectedSet = useMemo(
    () => new Set(selected.map(SELECTED_KEY)),
    [selected],
  );

  const fetchList = async () => {
    setLoading(true);
    setError(null);
    try {
      const procs = await api.listProcesses();
      setProcesses(procs);
    } catch (e) {
      const msg =
        e instanceof TauriCommandError
          ? `${e.kind}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const browseExecutable = async () => {
    if (disabled || browsing) return;
    setBrowsing(true);
    setError(null);
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        title: t("routing.selectAppExecutable"),
      });
      const pickedPath = Array.isArray(picked) ? picked[0] : picked;
      if (!pickedPath) return;

      // macOS bundles route by CFBundleExecutable, not by the `.app`
      // directory name. Rust returns only the process name, so the
      // installation path never enters settings or exported configs.
      const name = await api.resolveProcessName(pickedPath);

      const key = SELECTED_KEY(name);
      if (!selectedSet.has(key)) onChange([...selected, name]);
      setQuery(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBrowsing(false);
    }
  };

  // Lazy-load on first open.
  useEffect(() => {
    if (open && processes.length === 0 && !loading && !error) {
      void fetchList();
    }
    // We intentionally don't add `processes` / `loading` / `error` deps:
    // the open-once pattern is exactly what we want here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return processes;
    return processes.filter((p) => p.name.toLowerCase().includes(q));
  }, [processes, query]);

  const toggle = (name: string) => {
    const key = SELECTED_KEY(name);
    if (selectedSet.has(key)) {
      onChange(selected.filter((n) => SELECTED_KEY(n) !== key));
    } else {
      onChange([...selected, name]);
    }
  };

  return (
    <div className="atlas-process-picker mt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        disabled={disabled}
        className={cn(
          "w-full flex items-center justify-between px-3.5 py-2.5 text-xs text-muted-foreground hover:text-foreground font-medium transition",
          disabled && "opacity-50 cursor-not-allowed hover:text-muted-foreground",
        )}
      >
        <span className="flex items-center gap-2">
          <ListChecks size={13} className="text-theme-accent" />
          {open ? t("routing.hideProcessList") : t("routing.pickFromProcesses")}
        </span>
        {selected.length > 0 && (
          <span className="atlas-meta">
            {t("routing.activeProcessesCount", { count: selected.length })}
          </span>
        )}
      </button>
      {open && (
        <div className="border-t border-border/80 p-3 space-y-3">
          {/* Search + refresh */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("routing.searchProcessesPlaceholder")}
              disabled={disabled}
              className="atlas-input flex-1"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={browseExecutable}
              disabled={disabled || browsing}
              title={t("routing.addExecutableFromDisk")}
            >
              {browsing ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <FilePlus2 size={12} />
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={fetchList}
              disabled={loading}
              title={t("routing.refreshProcesses")}
            >
              {loading ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RefreshCw size={12} />
              )}
            </Button>
          </div>

          {/* Status line */}
          {error ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive-foreground flex items-center justify-between">
              <span>{t("routing.failedListProcesses", { error })}</span>
              <button
                type="button"
                onClick={() => setError(null)}
                className="text-destructive-foreground/80 hover:text-destructive-foreground"
                aria-label={t("common.close")}
              >
                <X size={12} />
              </button>
            </div>
          ) : loading && processes.length === 0 ? (
            <div className="text-[11px] text-muted-foreground px-1">
              {t("routing.loadingProcesses")}
            </div>
          ) : processes.length === 0 ? (
            <div className="text-[11px] text-muted-foreground px-1">
              {t("routing.noProcessesFound")}
            </div>
          ) : (
            <div className="text-[11px] text-muted-foreground px-1">
              {query
                ? t("routing.matchingProcessesCount", { count: filtered.length, total: processes.length, query })
                : t("routing.allProcessesCount", { count: filtered.length, total: processes.length })}
            </div>
          )}

          {/* List */}
          {filtered.length > 0 && (
            <div className="atlas-pick-list max-h-56 overflow-y-auto">
              {filtered.map((p) => {
                const active = selectedSet.has(SELECTED_KEY(p.name));
                return (
                  <button aria-pressed={active}
                    key={p.pid}
                    type="button"
                    onClick={() => toggle(p.name)}
                    disabled={disabled}
                    className="atlas-pick-row"
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span
                        className={cn(
                          "inline-block w-3.5 h-3.5 rounded border flex-shrink-0 transition",
                          active
                            ? "bg-theme-accent border-theme-accent"
                            : "border-border/80 bg-background/50",
                        )}
                        aria-hidden
                      />
                      <span className="truncate text-foreground font-mono">
                        {p.name}
                      </span>
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      pid {p.pid}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
