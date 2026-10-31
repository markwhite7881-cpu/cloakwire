import { describe, expect, it } from "vitest";
import fixture from "./fixtures/connection-health.json";
import { applyHealthEvent, isHealthFresh, type ConnectionHealth, type SessionIdentity } from "./connectionHealth";

const healthy = fixture as ConnectionHealth;
const expected: SessionIdentity = healthy;
describe("session owned health", () => {
  it("accepts an exact identity without losing large string IDs", () => {
    expect(applyHealthEvent(null, healthy, expected, healthy.operation_id)).toEqual(healthy);
    expect(healthy.run_id).toBe("18446744073709551615");
  });
  it.each([
    { run_id: "7" }, { profile_revision: "5" }, { network_generation: "2" },
    { effective_outbound_revision: "other-member" },
    { profile_ref: { kind: "manual", id: "other" } },
  ])("rejects a result from another identity: %j", change => {
    const event = { ...healthy, ...change, outcome: "failed" } as ConnectionHealth;
    expect(applyHealthEvent(healthy, event, expected, healthy.operation_id)).toBe(healthy);
  });
  it("Stop and a new operation reject late results even for the same profile", () => {
    expect(applyHealthEvent(null, healthy, null, null)).toBeNull();
    expect(applyHealthEvent(healthy, { ...healthy, operation_id: "old", outcome: "failed" }, expected, healthy.operation_id)).toBe(healthy);
  });
  it("separates selected profile health from an accepted session", () => {
    expect(applyHealthEvent(healthy, { ...healthy, scope: "selected_profile" }, expected, healthy.operation_id, "active_session")).toBe(healthy);
  });
  it("expiry and identity changes invalidate a formerly healthy badge", () => {
    const checked = Date.parse(healthy.checked_at!);
    expect(isHealthFresh(healthy, expected, checked + 59999)).toBe(true);
    expect(isHealthFresh(healthy, expected, checked + 60000)).toBe(false);
    expect(isHealthFresh(healthy, { ...expected, profile_revision: "8" }, checked)).toBe(false);
    expect(isHealthFresh(healthy, expected, checked - 1)).toBe(false);
  });
});
