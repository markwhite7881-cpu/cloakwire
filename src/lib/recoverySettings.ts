/** Recovery is a preference, never a command to connect or alter a profile. */
export const RECOVERY_KEY = "cloakwire.recovery.enabled.v1";
type PreferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export interface RecoveryPreferenceState {
  enabled: boolean;
  busy: boolean;
  issue: "apply" | "save" | null;
}
export function readRecoveryPreference(storage: Pick<PreferenceStorage, "getItem">): boolean {
  try { return storage.getItem(RECOVERY_KEY) === "true"; } catch { return false; }
}
export class RecoverySettings {
  private state: RecoveryPreferenceState;
  private listeners = new Set<() => void>();
  private initialization: Promise<void> | null = null;
  constructor(private storage: PreferenceStorage, private apply: (enabled: boolean) => Promise<void>) {
    this.state = { enabled: readRecoveryPreference(storage), busy: true, issue: null };
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(patch: Partial<RecoveryPreferenceState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  initialize(): Promise<void> {
    return this.initialization ??= this.synchronize();
  }
  private async synchronize() {
    this.publish({ busy: true });
    try {
      await this.apply(this.state.enabled);
      this.publish({ issue: null });
    } catch {
      this.publish({ issue: "apply" });
    } finally {
      this.publish({ busy: false });
    }
  }
  async setEnabled(enabled: boolean): Promise<void> {
    if (this.state.busy || (this.state.enabled === enabled && !this.state.issue)) return;
    this.publish({ busy: true, issue: null });
    let saved = true;
    // First persist an opt-out: a failed enable must never enable on next launch.
    try { this.storage.setItem(RECOVERY_KEY, "false"); } catch { saved = false; }
    if (!saved && enabled) {
      this.publish({ busy: false, issue: "save" });
      return;
    }
    try {
      await this.apply(enabled);
      this.publish({ enabled });
      if (enabled) {
        try { this.storage.setItem(RECOVERY_KEY, "true"); } catch {
          // If the final write fails, return to disabled whenever native allows.
          try { await this.apply(false); this.publish({ enabled: false }); } catch { /* Last acknowledged state is still enabled. */ }
          saved = false;
        }
      }
      if (!saved) this.publish({ issue: "save" });
    } catch {
      this.publish({ issue: "apply" });
    } finally {
      this.publish({ busy: false });
    }
  }
}
