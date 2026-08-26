export interface DiagnosticsInput {
  platform: string;
  appVersion: string;
  coreVersion?: string | null;
  logLines?: string[];
}

const SHARE_LINK = /\b(?:vless|vmess|trojan|ss|ssr|hysteria2?|tuic):\/\/[^\s]+/gi;
const HTTP_URL = /\bhttps?:\/\/[^\s]+/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const EMAIL = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g;
const LONG_TOKEN = /\b[A-Za-z0-9+/_=-]{32,}\b/g;

export function redactDiagnosticText(value: string): string {
  return value
    .replace(SHARE_LINK, "<proxy-url>")
    .replace(HTTP_URL, "<url>")
    .replace(UUID, "<uuid>")
    .replace(IPV4, "<ip>")
    .replace(EMAIL, "<email>")
    .replace(LONG_TOKEN, "<token>");
}

export function buildDiagnosticsReport(input: DiagnosticsInput): string {
  const lines = (input.logLines ?? [])
    .slice(-200)
    .map((line) => redactDiagnosticText(String(line).slice(0, 1000)));
  return [
    "Cloakwire diagnostics",
    `generated_at: ${new Date().toISOString()}`,
    `platform: ${redactDiagnosticText(input.platform)}`,
    `app_version: ${redactDiagnosticText(input.appVersion)}`,
    `core_version: ${redactDiagnosticText(input.coreVersion ?? "unknown")}`,
    "",
    `logs (${lines.length} lines, sanitized):`,
    ...lines,
  ].join("\n");
}

export async function copyTextToClipboard(value: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  if (typeof document === "undefined") throw new Error("Clipboard is unavailable");
  const area = document.createElement("textarea");
  area.value = value;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.focus();
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error("Clipboard copy failed");
}
