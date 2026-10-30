import { describe, expect, it } from "vitest";
import type { ActiveChildConfig } from "@/lib/types";
import { connectSelectedProfile } from "./connectWithSelection";

const selected = { subscriptionId: "sub-1", childKey: "child-1", childName: "Germany", engine: "singbox" as const };

describe("ready profile selection", () => {
  it("reports rejected lookup without starting another profile or changing selection", async () => {
    const started: unknown[] = [];
    const errors: unknown[] = [];
    await connectSelectedProfile(selected, {
      loadChild: async () => { throw { kind: "profile_check_dns", message: "secret" }; },
      connect: async (...args) => { started.push(args); },
      reportError: (error) => { errors.push(error); },
    });
    expect(started).toEqual([]);
    expect(errors).toEqual(["profile_check_dns"]);
  });

  it("rejects a stale child without silently choosing the new child or manual servers", async () => {
    const started: unknown[] = [];
    const errors: unknown[] = [];
    await connectSelectedProfile(selected, {
      loadChild: async () => ({ engine: "singbox", child_key: "another-child", child_name: "Other", config: "secret" }),
      connect: async (...args) => { started.push(args); },
      reportError: (error) => { errors.push(error); },
    });
    expect(started).toEqual([]);
    expect(errors).toEqual(["profile_check_invalid"]);
  });

  it("passes the selected child's own engine and name to native validation", async () => {
    const started: unknown[] = [];
    const child: ActiveChildConfig = { engine: "xray", child_key: "child-1", child_name: "Germany", config: '{"test":"config"}' };
    await connectSelectedProfile(selected, {
      loadChild: async () => child,
      connect: async (...args) => { started.push(args); },
      reportError: () => { throw new Error("Unexpected error"); },
    });
    expect(started).toEqual([[{ engine: "xray", config: '{"test":"config"}', name: "Germany" }, "Germany"]]);
  });

  it("preserves normal manual connection behavior when no ready profile is selected", async () => {
    const started: unknown[] = [];
    await connectSelectedProfile(null, {
      loadChild: async () => { throw new Error("Must not read a bundle"); },
      connect: async (...args) => { started.push(args); },
      reportError: () => { throw new Error("Unexpected error"); },
    });
    expect(started).toEqual([[]]);
  });
});
