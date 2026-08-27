import type { VpnState } from "../../lib/vpn";

/** Preserve a pending change once it was made while a VPN session was active. */
export function nextReconnectRequired(
  reconnectRequired: boolean,
  state: VpnState,
): boolean {
  return reconnectRequired || state === "running";
}

/**
 * Keep the reconnect action available while it is running, when a live tunnel
 * still needs its updated configuration, or after a failed retry.
 */
export function shouldShowReconnectNotice({
  reconnectInProgress,
  reconnectRequired,
  reconnectFailed,
  state,
}: {
  reconnectInProgress: boolean;
  reconnectRequired: boolean;
  reconnectFailed: boolean;
  state: VpnState;
}): boolean {
  return (
    reconnectInProgress ||
    (reconnectRequired && state === "running") ||
    (reconnectFailed && (state === "stopped" || state === "error"))
  );
}
