import { invoke } from "@tauri-apps/api/core";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SpeedTestRunner,
  calculateJitter,
  loadSpeedTestHistory,
  saveSpeedTestResult,
  clearSpeedTestHistory,
  type SpeedTestResult,
} from "./speedtest";

vi.mock("@tauri-apps/api/core", async (original) => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: vi.fn(), Channel: class { onmessage = () => {}; } }));

describe("speed test connectivity", () => {
  it("allows Cloudflare endpoints through the application CSP", () => {
    const config = JSON.parse(
      readFileSync(resolve(process.cwd(), "src-tauri/tauri.conf.json"), "utf8"),
    );
    const connectSrc = config.app.security.csp
      .split(";")
      .find((directive: string) => directive.trim().startsWith("connect-src "));

    expect(connectSrc).toContain("https://speed.cloudflare.com");
  });
});

describe("speedtest", () => {
  let mockStore: Record<string, string> = {};

  beforeEach(() => {
    mockStore = {};
    (globalThis as any).localStorage = {
      getItem: (key: string) => mockStore[key] ?? null,
      setItem: (key: string, value: string) => {
        mockStore[key] = value;
      },
      removeItem: (key: string) => {
        delete mockStore[key];
      },
      clear: () => {
        mockStore = {};
      },
    };
  });

  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it("discards damaged rows but keeps complete old results with or without metadata", () => {
    const old = { id: "old", timestamp: 153000, serverName: "Office", vpnActive: true, ping: 0, jitter: 0, uploadSpeed: 1, downloadSpeed: 0 };
    const newer = { ...old, id: "new", clientIp: "203.0.113.5", colo: "HEL" };
    mockStore["cloakwire.speedtest.history"] = JSON.stringify([
      null, {}, newer, { ...old, ping: -1 }, { ...old, uploadSpeed: "5" },
      { ...old, timestamp: 1e24 }, { ...old, location: {} }, { ...old, vpnActive: 1 }, old,
    ]);
    expect(loadSpeedTestHistory()).toEqual([newer, old]);
  });

  it.each(["null", "{}", "not JSON", "[]"])("reads %s as an empty history", raw => {
    mockStore["cloakwire.speedtest.history"] = raw;
    expect(loadSpeedTestHistory()).toEqual([]);
  });

  it.each([null, "run-id"])("never falls back to WebView if Android's active route is unavailable (%s)", async androidRunId => {
    const fetch = vi.fn().mockRejectedValue(new Error("unexpected web request"));
    vi.stubGlobal("fetch", fetch);
    vi.mocked(invoke).mockRejectedValue("speedtest_route_unavailable");
    const runner = new SpeedTestRunner();
    await expect(runner.run({ vpnActive: true, serverName: "Office", androidRunId }, () => {})).rejects.toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(loadSpeedTestHistory()).toEqual([]);
  });

  it("uses only native measurements for a supported Android VPN session", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("unexpected web request"));
    vi.stubGlobal("fetch", fetch);
    vi.mocked(invoke).mockResolvedValue({ pingMs: 19, jitterMs: 3, downloadMbps: 77, uploadMbps: 23, colo: "HEL" });
    const result = await new SpeedTestRunner().run({vpnActive: true, serverName: "Office", androidRunId: "current-run"}, () => {});
    expect(invoke).toHaveBeenCalledWith("android_vpn_speed_test", expect.objectContaining({runId: "current-run"}));
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({vpnActive: true, serverName: "Office", downloadSpeed: 77, uploadSpeed: 23, ping: 19, jitter: 3, colo: "HEL"});
    expect(loadSpeedTestHistory()).toEqual([result]);
  });

  it("discards a late native result after cancellation", async () => {
    let finish!: (p: unknown) => void;
    vi.mocked(invoke).mockImplementation(cmd => cmd === "android_vpn_speed_test"
      ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(undefined));
    const runner = new SpeedTestRunner();
    const pending = runner.run({vpnActive: true, serverName: "Office", androidRunId: "run"}, () => {});
    runner.stop();
    finish({ pingMs: 20, jitterMs: 0, downloadMbps: 12, uploadMbps: 7 });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(invoke).toHaveBeenCalledWith("cancel_android_speed_test", expect.objectContaining({operationId: expect.any(String)}));
    expect(loadSpeedTestHistory()).toEqual([]);
  });

  it("rejects an incomplete native response instead of recording a zero-speed VPN", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    await expect(new SpeedTestRunner().run({vpnActive: true, serverName: "Office", androidRunId: "run"}, () => {})).rejects.toThrow();
    expect(loadSpeedTestHistory()).toEqual([]);
  });

  describe("calculateJitter", () => {
    it("returns 0 for empty or single-item lists", () => {
      expect(calculateJitter([])).toBe(0);
      expect(calculateJitter([25])).toBe(0);
    });

    it("correctly calculates mean absolute difference between sequential pings", () => {
      // differences: |20 - 30| = 10, |30 - 25| = 5, |25 - 35| = 10
      // mean diff: (10 + 5 + 10) / 3 = 25 / 3 = 8.333 -> 8.3
      const pings = [20, 30, 25, 35];
      expect(calculateJitter(pings)).toBe(8.3);
    });
  });

  describe("history storage", () => {
    it("saves and loads speed test results in chronological order", () => {
      expect(loadSpeedTestHistory()).toEqual([]);

      const sample1: SpeedTestResult = {
        id: "test-1",
        timestamp: 1000,
        serverName: "Frankfurt VLESS",
        vpnActive: true,
        ping: 28,
        jitter: 2.1,
        downloadSpeed: 145.2,
        uploadSpeed: 48.6,
      };

      const sample2: SpeedTestResult = {
        id: "test-2",
        timestamp: 2000,
        serverName: "Amsterdam HY2",
        vpnActive: true,
        ping: 22,
        jitter: 1.4,
        downloadSpeed: 210.8,
        uploadSpeed: 64.0,
      };

      saveSpeedTestResult(sample1);
      const afterTwo = saveSpeedTestResult(sample2);

      expect(afterTwo.length).toBe(2);
      expect(afterTwo[0].id).toBe("test-2");
      expect(afterTwo[1].id).toBe("test-1");

      const loaded = loadSpeedTestHistory();
      expect(loaded.length).toBe(2);
      expect(loaded[0].serverName).toBe("Amsterdam HY2");

      clearSpeedTestHistory();
      expect(loadSpeedTestHistory()).toEqual([]);
    });
  });
});
