import assert from "node:assert/strict";
import { test } from "vitest";
import {
  nextReconnectRequired,
  shouldShowReconnectNotice,
} from "./reconnectState.ts";

test("keeps reconnect pending after repeated changes made while the VPN is running", () => {
  const afterFirstChange = nextReconnectRequired(false, "running");
  const afterSecondChange = nextReconnectRequired(afterFirstChange, "running");

  assert.equal(afterFirstChange, true);
  assert.equal(afterSecondChange, true);
});

test("does not create a reconnect notice for changes made while stopped", () => {
  assert.equal(nextReconnectRequired(false, "stopped"), false);
  assert.equal(
    shouldShowReconnectNotice({
      reconnectInProgress: false,
      reconnectRequired: false,
      reconnectFailed: false,
      state: "stopped",
    }),
    false,
  );
});

test("keeps the reconnect notice visible across disconnect and connect states", () => {
  for (const state of ["stopped", "starting"] as const) {
    assert.equal(
      shouldShowReconnectNotice({
        reconnectInProgress: true,
        reconnectRequired: true,
        reconnectFailed: false,
        state,
      }),
      true,
    );
  }
});

test("keeps a retry notice visible after a reconnect failure stops the VPN", () => {
  assert.equal(
    shouldShowReconnectNotice({
      reconnectInProgress: false,
      reconnectRequired: true,
      reconnectFailed: true,
      state: "stopped",
    }),
    true,
  );
});
