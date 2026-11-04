import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HomeTraffic } from "./SpeedTestTab";
import type { TrafficSample } from "@/lib/types";

const sample = (down: number, up: number, time: number): TrafficSample => ({
  down_bps: down * 125_000, up_bps: up * 125_000,
  down_total: 1048576, up_total: 524288, ts_ms: time,
});

function graph(samples: TrafficSample[]) {
  return renderToStaticMarkup(
    <HomeTraffic samples={samples} current={samples.at(-1) ?? null} vpnActive activeProfileName="Office" />,
  );
}

function trace(html: string, series: string) {
  const path = html.match(new RegExp(`<path[^>]*data-series="${series}"[^>]*>`))?.[0];
  expect(path).toBeDefined();
  return path?.match(/ d="([^"]*)"/)?.[1] ?? "";
}

describe("home traffic graph", () => {
  it("renders stored jitter, exit address and Cloudflare edge in history", () => {
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify([{
      id: "history", timestamp: 1, serverName: "Office", vpnActive: true,
      ping: 20, jitter: 7, downloadSpeed: 10, uploadSpeed: 3,
      clientIp: "203.0.113.63", colo: "FRA",
    }]) });
    try {
      const html = graph([]);
      expect(html).toContain("7 ms");
      expect(html).toContain("203.0.113.63");
      expect(html).toContain("FRA");
    } finally { vi.unstubAllGlobals(); }
  });

  it("draws separate smooth traces through measured rates and keeps their numeric labels", () => {
    const html = graph([sample(0, 1, 0), sample(8, 2, 1000), sample(4, 0, 2000)]);
    expect(html).toContain('role="img"');
    expect(html).toContain("4 Mbps");
    expect(html).toContain("0 Mbps");
    expect(trace(html, "down")).toMatch(/C.*1000[ ,]37(?:\.0+)?$/);
    expect(trace(html, "up")).toMatch(/C.*1000[ ,]68(?:\.0+)?$/);
  });

  it("leaves missing history empty and keeps real zero samples on the baseline", () => {
    expect(trace(graph([]), "down")).toBe("");
    const idle = trace(graph([sample(0, 0, 0), sample(0, 0, 1000)]), "down");
    expect(idle).toContain("C");
    const numbers = idle.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    expect(numbers[0]).toBeGreaterThan(0);
    expect(numbers.filter((_, index) => index % 2 === 1).every(y => y === 68)).toBe(true);
  });
});
