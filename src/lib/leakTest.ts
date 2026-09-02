import { api } from "./api";
import type { LeakStatusReport } from "./types";

export interface LeakTestResult {
  timestamp: number;
  publicIp: string;
  country: string;
  isp: string;
  dnsServer: string | null;
  ipv6Detected: boolean;
  webrtcIps: string[];
  verdict: "protected" | "leaking" | "checking" | "error";
  details: string[];
}

/**
 * Detect WebRTC candidate IPs using an ephemeral RTCPeerConnection and Google STUN.
 * Resolves with all discovered candidates (local and reflexive).
 */
export async function detectWebRtcIps(): Promise<string[]> {
  if (typeof window === "undefined" || !window.RTCPeerConnection) {
    return [];
  }
  return new Promise((resolve) => {
    const ips = new Set<string>();
    let settled = false;

    let rtc: RTCPeerConnection | null = null;
    const finish = () => {
      if (!settled) {
        settled = true;
        if (rtc) {
          try {
            rtc.close();
          } catch {
            // Ignore cleanup error
          }
        }
        resolve(Array.from(ips));
      }
    };

    try {
      rtc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      rtc.createDataChannel("leak-test");
      rtc
        .createOffer()
        .then((offer) => rtc?.setLocalDescription(offer))
        .catch(() => finish());

      rtc.onicecandidate = (event) => {
        if (!event || !event.candidate) {
          finish();
          return;
        }
        const candidate = event.candidate.candidate;
        const ipRegex = /([0-9]{1,3}(\.[0-9]{1,3}){3}|[a-f0-9]{1,4}(:[a-f0-9]{1,4}){7})/gi;
        const matches = candidate.match(ipRegex);
        if (matches) {
          for (const ip of matches) {
            if (!ip.startsWith("127.") && ip !== "::1") {
              ips.add(ip);
            }
          }
        }
      };

      setTimeout(finish, 2500);
    } catch {
      finish();
    }
  });
}

/**
 * Run comprehensive multi-vector leak diagnostics:
 * - Public IP & ISP lookup
 * - Dual-stack IPv6 dual-route detection
 * - WebRTC STUN reflexive candidate leak check
 * - DNS resolver observation
 */
export async function runLeakDiagnostics(baselineIp?: string): Promise<LeakTestResult> {
  const details: string[] = [];
  let statusReport: LeakStatusReport = {
    ip: "—",
    country: "—",
    isp: "—",
    ipv6_detected: false,
    dns_server: null,
  };

  try {
    statusReport = await api.checkLeakStatus();
  } catch {
    // Fallback if Tauri command fails or running in web preview
    try {
      const res = await fetch("https://api.ipify.org?format=json");
      if (res.ok) {
        const data = (await res.json()) as { ip?: string };
        statusReport.ip = data.ip ?? "—";
      }
    } catch {
      // Offline or blocked
    }
  }

  const webrtcIps = await detectWebRtcIps();

  let verdict: "protected" | "leaking" | "error" = "protected";

  if (statusReport.ip === "—" || !statusReport.ip) {
    verdict = "error";
    details.push("Не удалось определить публичный IP адрес (проверьте подключение).");
  } else {
    details.push(`Публичный IP: ${statusReport.ip} (${statusReport.country}, ${statusReport.isp})`);

    if (baselineIp && baselineIp !== "—" && statusReport.ip === baselineIp) {
      verdict = "leaking";
      details.push("Внимание: Текущий IP совпадает с вашим исходным IP провайдера!");
    }

    if (statusReport.ipv6_detected) {
      verdict = "leaking";
      details.push("Обнаружена утечка IPv6: протокол IPv6 активен в обход туннеля.");
    } else {
      details.push("IPv6 надежно заблокирован (утечек нет).");
    }

    if (statusReport.dns_server) {
      details.push(`DNS резолвер: ${statusReport.dns_server}`);
    }

    // WebRTC check: look for public IPs that differ from the VPN exit IP
    const leakedPublicWebRtc = webrtcIps.filter((ip) => {
      const isPrivateIpv4 =
        ip.startsWith("10.") ||
        ip.startsWith("192.168.") ||
        ip.startsWith("169.254.") ||
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip);
      const isPrivateIpv6 =
        ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80");
      return !isPrivateIpv4 && !isPrivateIpv6 && ip !== statusReport.ip;
    });

    if (leakedPublicWebRtc.length > 0) {
      verdict = "leaking";
      details.push(`WebRTC утечка реального IP: ${leakedPublicWebRtc.join(", ")}`);
    } else {
      details.push("WebRTC STUN утечек внешнего IP не обнаружено.");
    }
  }

  return {
    timestamp: Date.now(),
    publicIp: statusReport.ip,
    country: statusReport.country,
    isp: statusReport.isp,
    dnsServer: statusReport.dns_server,
    ipv6Detected: statusReport.ipv6_detected,
    webrtcIps,
    verdict,
    details,
  };
}
