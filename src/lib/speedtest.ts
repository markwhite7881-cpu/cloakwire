import { Channel, invoke } from "@tauri-apps/api/core";

export interface SpeedTestResult {
  id: string;
  timestamp: number;
  serverName: string;
  vpnActive: boolean;
  ping: number; // ms
  jitter: number; // ms
  downloadSpeed: number; // Mbps
  uploadSpeed: number; // Mbps
  clientIp?: string;
  location?: string;
  colo?: string;
}

export type SpeedTestPhase = "idle" | "ping" | "download" | "upload" | "done" | "error";

export interface SpeedTestProgress {
  phase: SpeedTestPhase;
  currentSpeed: number; // live Mbps
  progressPercent: number; // 0..100
  pingMs: number;
  jitterMs: number;
  downloadMbps: number;
  uploadMbps: number;
  samples: number[];
  clientIp?: string;
  location?: string;
  colo?: string;
  error?: string;
}

const SPEEDTEST_HISTORY_KEY = "cloakwire.speedtest.history";
const MAX_HISTORY_ITEMS = 10;

function isMeasurement(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

function isSpeedTestResult(value: unknown): value is SpeedTestResult {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && row.id.length > 0 &&
    typeof row.serverName === "string" && typeof row.vpnActive === "boolean" &&
    typeof row.timestamp === "number" && isMeasurement(row.timestamp) && row.timestamp <= 8.64e15 &&
    [row.ping, row.jitter, row.downloadSpeed, row.uploadSpeed].every(isMeasurement) &&
    [row.clientIp, row.location, row.colo].every(v => v === undefined || typeof v === "string");
}

export function loadSpeedTestHistory(): SpeedTestResult[] {
  try {
    const raw = localStorage.getItem(SPEEDTEST_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSpeedTestResult).slice(0, MAX_HISTORY_ITEMS) : [];
  } catch {
    return [];
  }
}

export function saveSpeedTestResult(result: SpeedTestResult): SpeedTestResult[] {
  try {
    const current = loadSpeedTestHistory();
    const updated = [result, ...current.filter((r) => r.id !== result.id)].slice(
      0,
      MAX_HISTORY_ITEMS,
    );
    localStorage.setItem(SPEEDTEST_HISTORY_KEY, JSON.stringify(updated));
    return updated;
  } catch {
    return [result];
  }
}

export function clearSpeedTestHistory(): void {
  try {
    localStorage.removeItem(SPEEDTEST_HISTORY_KEY);
  } catch {}
}

/**
 * Calculates mean absolute jitter from an array of consecutive RTT probe measurements.
 */
export function calculateJitter(pings: number[]): number {
  if (pings.length < 2) return 0;
  let sumDiff = 0;
  for (let i = 1; i < pings.length; i++) {
    sumDiff += Math.abs(pings[i] - pings[i - 1]);
  }
  return Math.round((sumDiff / (pings.length - 1)) * 10) / 10;
}

/**
 * Runner class that executes ping, download, and upload benchmarks
 * with real-time progress callbacks and cancellation support.
 */
export class SpeedTestRunner {
  private abortController: AbortController | null = null;
  private isRunning = false;

  public stop(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.isRunning = false;
  }

  public get running(): boolean {
    return this.isRunning;
  }

  public async run(
    meta: { serverName: string; vpnActive: boolean; androidRunId?: string | null },
    onProgress: (p: SpeedTestProgress) => void,
  ): Promise<SpeedTestResult> {
    this.stop();
    this.abortController = new AbortController();
    this.isRunning = true;
    const signal = this.abortController.signal;

    const progress: SpeedTestProgress = {
      phase: "ping",
      currentSpeed: 0,
      progressPercent: 5,
      pingMs: 0,
      jitterMs: 0,
      downloadMbps: 0,
      uploadMbps: 0,
      samples: [],
    };
    onProgress({ ...progress });

    try {
      if (meta.androidRunId !== undefined && meta.vpnActive) {
        if (!meta.androidRunId) throw new Error("speedtest_route_unavailable");
        const operationId = crypto.randomUUID();
        const channel = new Channel<SpeedTestProgress>();
        const cancel = () => { void invoke("cancel_android_speed_test", { operationId }).catch(() => {}); };
        channel.onmessage = p => { if (signal.aborted) cancel(); else onProgress(p); };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          const measured = await invoke<SpeedTestProgress>("android_vpn_speed_test", {
            runId: meta.androidRunId, operationId, onProgress: channel,
          });
          if (!measured || ![measured.pingMs, measured.jitterMs, measured.downloadMbps, measured.uploadMbps].every(isMeasurement)) {
            throw new Error("speedtest_request_failed");
          }
          Object.assign(progress, measured);
        } catch (cause) {
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          throw new Error(String(cause).includes("speedtest_route_unavailable") ? "speedtest_route_unavailable" : "speedtest_request_failed");
        } finally {
          signal.removeEventListener("abort", cancel);
        }
      } else {
        await this.measureWeb(progress, signal, onProgress);
      }
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");

      // 4. DONE PHASE
      progress.phase = "done";
      progress.progressPercent = 100;
      progress.currentSpeed = progress.downloadMbps;
      onProgress({ ...progress });

      const finalResult: SpeedTestResult = {
        id: "speed-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        timestamp: Date.now(),
        serverName: meta.serverName,
        vpnActive: meta.vpnActive,
        ping: progress.pingMs,
        jitter: progress.jitterMs,
        downloadSpeed: progress.downloadMbps,
        uploadSpeed: progress.uploadMbps,
        clientIp: progress.clientIp,
        location: progress.location,
        colo: progress.colo,
      };

      saveSpeedTestResult(finalResult);
      this.isRunning = false;
      return finalResult;
    } catch (err: any) {
      this.isRunning = false;
      if (err.name === "AbortError") {
        progress.phase = "idle";
        progress.currentSpeed = 0;
        progress.progressPercent = 0;
        onProgress({ ...progress });
        throw err;
      }
      progress.phase = "error";
      progress.error = err.message || "Speed test failed";
      onProgress({ ...progress });
      throw err;
    }
  }

  private async measureWeb(
    progress: SpeedTestProgress,
    signal: AbortSignal,
    onProgress: (p: SpeedTestProgress) => void,
  ): Promise<void> {
    const pings: number[] = [];
    let detectedIp = "";
    let detectedLocation = "";
    let detectedColo = "";

    // 4 probe requests
    for (let i = 0; i < 4; i++) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const t0 = performance.now();
      const res = await fetch(`https://speed.cloudflare.com/__down?bytes=0&_t=${Date.now()}_${i}`, {
        method: "GET",
        cache: "no-store",
        signal,
      });
      const rtt = Math.max(1, Math.round(performance.now() - t0));
      pings.push(rtt);

      if (!detectedIp) {
        detectedIp = res.headers.get("cf-meta-ip") || "";
        const country = res.headers.get("cf-meta-country") || "";
        const city = res.headers.get("cf-meta-city") || "";
        detectedLocation = [city, country].filter(Boolean).join(", ");
        detectedColo = res.headers.get("cf-meta-colo") || "";
      }

      progress.pingMs = Math.round(pings.reduce((a, b) => a + b, 0) / pings.length);
      progress.jitterMs = calculateJitter(pings);
      progress.progressPercent = 5 + (i + 1) * 5;
      progress.clientIp = detectedIp;
      progress.location = detectedLocation;
      progress.colo = detectedColo;
      onProgress({ ...progress });
    }

    // 2. DOWNLOAD PHASE
    progress.phase = "download";
    progress.progressPercent = 25;
    onProgress({ ...progress });

    const downloadBytes = 15_000_000; // 15 MB payload chunk
    const downStart = performance.now();
    const downRes = await fetch(
      `https://speed.cloudflare.com/__down?bytes=${downloadBytes}&_t=${Date.now()}`,
      {
        method: "GET",
        cache: "no-store",
        signal,
      },
    );

    if (!downRes.ok) throw new Error(`Download probe failed: ${downRes.status}`);

    const reader = downRes.body?.getReader();
    let receivedBytes = 0;
    let lastSampleTime = downStart;
    let lastSampleBytes = 0;

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedBytes += value ? value.byteLength : 0;
        const now = performance.now();

        // Update metrics at ~80ms cadence
        if (now - lastSampleTime >= 80) {
          const dt = (now - lastSampleTime) / 1000;
          const chunkBytes = receivedBytes - lastSampleBytes;
          const instantMbps = (chunkBytes * 8) / (dt * 1_000_000);

          progress.currentSpeed = Math.round(instantMbps * 10) / 10;
          progress.samples.push(progress.currentSpeed);
          if (progress.samples.length > 40) progress.samples.shift();

          const overallElapsed = (now - downStart) / 1000;
          progress.downloadMbps =
            Math.round(((receivedBytes * 8) / (overallElapsed * 1_000_000)) * 10) / 10;
          progress.progressPercent = Math.min(65, 25 + Math.round((receivedBytes / downloadBytes) * 40));
          onProgress({ ...progress });

          lastSampleTime = now;
          lastSampleBytes = receivedBytes;
        }
      }
    }

    const totalDownTime = Math.max(0.01, (performance.now() - downStart) / 1000);
    progress.downloadMbps = Math.round(((receivedBytes * 8) / (totalDownTime * 1_000_000)) * 10) / 10;
    progress.currentSpeed = progress.downloadMbps;
    progress.progressPercent = 65;
    onProgress({ ...progress });

    // 3. UPLOAD PHASE
    progress.phase = "upload";
    progress.samples = [];
    progress.progressPercent = 70;
    onProgress({ ...progress });

    // Create random buffer for upload (3 MB)
    const uploadChunkSize = 1024 * 1024; // 1 MB
    const uploadBuffers = 3;
    const uploadPayload = new Uint8Array(uploadChunkSize);
    for (let i = 0; i < uploadPayload.length; i += 1024) {
      uploadPayload[i] = (i * 31) & 0xff;
    }

    let uploadedTotalBytes = 0;
    const upStart = performance.now();

    for (let chunk = 0; chunk < uploadBuffers; chunk++) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const chunkT0 = performance.now();
      const upRes = await fetch("https://speed.cloudflare.com/__up", {
        method: "POST",
        body: uploadPayload,
        cache: "no-store",
        signal,
      });
      if (!upRes.ok) throw new Error(`Upload probe failed: ${upRes.status}`);

      const chunkDuration = Math.max(0.01, (performance.now() - chunkT0) / 1000);
      uploadedTotalBytes += uploadPayload.byteLength;
      const instantMbps = (uploadPayload.byteLength * 8) / (chunkDuration * 1_000_000);

      progress.currentSpeed = Math.round(instantMbps * 10) / 10;
      progress.samples.push(progress.currentSpeed);

      const totalUpElapsed = Math.max(0.01, (performance.now() - upStart) / 1000);
      progress.uploadMbps =
        Math.round(((uploadedTotalBytes * 8) / (totalUpElapsed * 1_000_000)) * 10) / 10;
      progress.progressPercent = Math.min(95, 70 + Math.round(((chunk + 1) / uploadBuffers) * 25));
      onProgress({ ...progress });
    }

    const totalUpTime = Math.max(0.01, (performance.now() - upStart) / 1000);
    progress.uploadMbps = Math.round(((uploadedTotalBytes * 8) / (totalUpTime * 1_000_000)) * 10) / 10;
  }
}
