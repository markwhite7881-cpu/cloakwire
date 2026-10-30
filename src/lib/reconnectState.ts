import type { Status } from "./types";

/**
 * Preserve a pending settings-change flag once it has been raised while the
 * managed process was running. Stopped edits do not create the flag.
 */
export function nextReconnectRequired(
  reconnectRequired: boolean,
  isRunning: boolean,
): boolean {
  return reconnectRequired || isRunning;
}

export function shouldReconnectAfterProfileSelection(status: Status): boolean {
  return status === "running";
}

export function shouldShowReconnectNotice({
  reconnectInProgress,
  reconnectRequired,
  reconnectFailed,
  status,
}: {
  reconnectInProgress: boolean;
  reconnectRequired: boolean;
  reconnectFailed: boolean;
  status: Status;
}): boolean {
  return (
    reconnectInProgress ||
    (reconnectRequired && status === "running") ||
    (reconnectFailed && (status === "stopped" || status === "crashed"))
  );
}

/** Ready profiles are checked and replaced atomically by their native start path. */
export async function reconnectSelectedProfile<T>({
  readyProfile,
  stop,
  start,
}: {
  readyProfile: boolean;
  stop: () => Promise<void>;
  start: () => Promise<T>;
}): Promise<T> {
  if (!readyProfile) await stop();
  return start();
}
