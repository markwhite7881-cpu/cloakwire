// Minimal share-link → `Outbound` parser for the Android WebView.
//
// On desktop the parsing happens in the Rust core
// (`parse_link` / `parse_links` / `parse_input`). The Android
// Tauri WebView does not have access to the Rust core, so we ship
// a TypeScript parser that mirrors what sing-box's Go runtime
// would produce. Subscription bodies come in four shapes:
//
//   1. base64-encoded URI list      (v2ray / sing-box standard)
//   2. plain URI list, one per line (also v2ray / sing-box)
//   3. JSON object with an `outbounds` array (rare, mostly clash-meta)
//   4. Clash YAML config            (ClashforWindows / Clash.Meta)
//
// Anything else (full v2ray JSON config, Hysteria1 wire format, …)
// is reported as `errors > 0` with a `lastErrorKind: "unsupported"`.
// The user can always paste a single share-link into the manual
// slot, which the Rust `parse_link` would also have done on desktop.
//
// Each parsed `Outbound` carries `transport` and `tls` in the
// `Transport` / `TlsCfg` shape used everywhere else in the app
// (see `src/lib/types.ts`). Conversion to sing-box JSON happens in
// `outboundTransportToJson` in `previewConfig.ts`; conversion to
// xray JSON happens in `XrayConfigBuilder.mapOutbound` in the
// Kotlin plugin.

import { JSON_SCHEMA, load as yamlLoad } from "js-yaml";

import type {
  Outbound,
  TlsCfg,
  Transport,
  TuicOut,
  VmessOut,
} from "./types";

export interface ParseResult {
  outbounds: Outbound[];
  errors: number;
  /** First few lines of body for the lastError UI. */
  preview?: string;
}

const TAG_PREFIX = "sub-";

function base64ToText(s: string): string | null {
  try {
    const padded = s.replace(/[^A-Za-z0-9+/=]/g, "").padEnd(
      s.length + (4 - (s.length % 4)) % 4,
      "=",
    );
    const decoded = atob(padded);
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

function looksLikeBase64(trimmed: string): boolean {
  if (trimmed.length === 0 || trimmed.length > 256 * 1024) return false;
  if (trimmed.includes("://")) return false;
  return /^[A-Za-z0-9+/=\r\n]+$/.test(trimmed);
}

function maybeJsonArray(text: string): Outbound[] | null {
  const t = text.trim();
  if (!t.startsWith("[") && !t.startsWith("{")) return null;
  try {
    const root = JSON.parse(t) as unknown;
    const arr = Array.isArray(root)
      ? root
      : root && typeof root === "object" && Array.isArray((root as { outbounds?: unknown[] }).outbounds)
        ? (root as { outbounds: unknown[] }).outbounds
        : null;
    if (!arr) return null;
    return arr.filter(
      (x): x is Outbound =>
        x != null &&
        typeof x === "object" &&
        typeof (x as Outbound).protocol === "string",
    );
  } catch {
    return null;
  }
}

function tagFor(link: string, index: number, host: string): string {
  const hostTag = host
    .replace(/[^a-zA-Z0-9.-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  return `${TAG_PREFIX}${index}-${hostTag || "out"}`;
}

function safeAtob(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeBase64Std(s: string): string {
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  return new TextDecoder().decode(safeAtob(padded));
}

function headersFromHost(host: string | undefined): Array<[string, string]> {
  return host ? [["Host", host]] : [];
}

function parseTransport(params: URLSearchParams): Transport {
  const type = (params.get("type") || "tcp").toLowerCase();
  switch (type) {
    case "tcp":
      return { kind: "tcp" };
    case "ws": {
      const out: Transport = { kind: "ws", headers: headersFromHost(params.get("host") || undefined) };
      const path = params.get("path");
      if (path) out.path = path;
      return out;
    }
    case "http":
    case "h2": {
      const host = params.get("host") || undefined;
      const out: Transport = {
        kind: "http",
        host: host ? [host] : [],
      };
      const path = params.get("path");
      if (path) out.path = path;
      return out;
    }
    case "grpc": {
      const out: Transport = { kind: "grpc" };
      const sn = params.get("serviceName") || params.get("service_name");
      if (sn) out.service_name = sn;
      return out;
    }
    case "xhttp": {
      const host = params.get("host") || undefined;
      const out: Transport = {
        kind: "xhttp",
        host: host ? [host] : [],
      };
      const path = params.get("path");
      if (path) out.path = path;
      const mode = params.get("mode");
      if (mode) out.mode = mode;
      return out;
    }
    case "splithttp": {
      // sing-box 1.11+ and xray-core both understand `splithttp`
      // as a separate transport. The earlier versions of this file
      // collapsed it to xhttp+mode=split which works for sing-box
      // but xray treats it as plain xhttp; emit the dedicated kind
      // so both backends pick the right streamSettings.
      const host = params.get("host") || undefined;
      const out: Transport = {
        kind: "splithttp",
        host: host ? [host] : [],
      };
      const path = params.get("path");
      if (path) out.path = path;
      const mode = params.get("mode");
      if (mode) out.mode = mode;
      return out;
    }
    case "httpupgrade": {
      // sing-box 1.9+ and xray-core both implement httpupgrade
      // directly. Emit the dedicated kind so the produced config
      // matches the upstream wire format.
      const host = params.get("host") || undefined;
      const out: Transport = {
        kind: "httpupgrade",
        host: host ? [host] : [],
      };
      const path = params.get("path");
      if (path) out.path = path;
      return out;
    }
    default:
      return { kind: "tcp" };
  }
}

function parseTls(params: URLSearchParams): TlsCfg {
  const security = (params.get("security") || "").toLowerCase();
  const sni = params.get("sni") || params.get("peer") || undefined;
  const alpn = (params.get("alpn") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const fp = params.get("fp") || params.get("fingerprint") || undefined;
  const base: TlsCfg = {
    enabled: security === "tls" || security === "reality" || security === "xtls",
    server_name: sni,
    alpn,
    fingerprint: fp,
    allow_insecure: false,
  };
  if (security === "reality") {
    base.reality = {
      public_key: params.get("pbk") || params.get("publicKey") || "",
      short_id: params.get("sid") || params.get("shortId") || "",
    };
    const spx = params.get("spx") || params.get("spiderX");
    if (spx) base.reality.spider_x = spx;
  }
  return base;
}

function parseVless(link: string, tag: string): Outbound | null {
  const noScheme = link.slice("vless://".length);
  const hashIdx = noScheme.indexOf("#");
  const fragment = hashIdx >= 0 ? decodeURIComponent(noScheme.slice(hashIdx + 1)) : "";
  const head = hashIdx >= 0 ? noScheme.slice(0, hashIdx) : noScheme;
  const qIdx = head.indexOf("?");
  const tail = qIdx >= 0 ? head.slice(qIdx + 1) : "";
  const main = qIdx >= 0 ? head.slice(0, qIdx) : head;
  const atIdx = main.lastIndexOf("@");
  if (atIdx < 0) return null;
  const uuid = main.slice(0, atIdx);
  const hostPort = main.slice(atIdx + 1);
  const [host, portStr] = hostPort.split(":");
  const params = new URLSearchParams(tail);
  const flow = params.get("flow") || undefined;
  const out: Outbound = {
    protocol: "vless",
    tag: fragment || tag,
    server: host || "",
    port: Number.parseInt(portStr || "0", 10) || 0,
    uuid,
    transport: parseTransport(params),
    tls: parseTls(params),
  };
  if (flow) (out as { flow?: string }).flow = flow;
  return out;
}

function parseTrojan(link: string, tag: string): Outbound | null {
  const noScheme = link.slice("trojan://".length);
  const hashIdx = noScheme.indexOf("#");
  const fragment = hashIdx >= 0 ? decodeURIComponent(noScheme.slice(hashIdx + 1)) : "";
  const head = hashIdx >= 0 ? noScheme.slice(0, hashIdx) : noScheme;
  const qIdx = head.indexOf("?");
  const tail = qIdx >= 0 ? head.slice(qIdx + 1) : "";
  const main = qIdx >= 0 ? head.slice(0, qIdx) : head;
  const atIdx = main.lastIndexOf("@");
  if (atIdx < 0) return null;
  const password = main.slice(0, atIdx);
  const hostPort = main.slice(atIdx + 1);
  const [host, portStr] = hostPort.split(":");
  const params = new URLSearchParams(tail);
  return {
    protocol: "trojan",
    tag: fragment || tag,
    server: host || "",
    port: Number.parseInt(portStr || "0", 10) || 0,
    password: decodeURIComponent(password),
    transport: parseTransport(params),
    tls: parseTls(params),
  };
}

function parseShadowsocks(link: string, tag: string): Outbound | null {
  // ss://base64(method:password)@host:port#name  (SIP002)
  // or  ss://base64(method:password@host:port)#name    (legacy)
  const noScheme = link.slice("ss://".length);
  const hashIdx = noScheme.indexOf("#");
  const fragment = hashIdx >= 0 ? decodeURIComponent(noScheme.slice(hashIdx + 1)) : "";
  const head = hashIdx >= 0 ? noScheme.slice(0, hashIdx) : noScheme;
  let main = head;
  let method = "";
  let password = "";
  if (main.includes("@")) {
    const atIdx = main.lastIndexOf("@");
    const userInfo = main.slice(0, atIdx);
    main = main.slice(atIdx + 1);
    let decoded = userInfo;
    try { decoded = decodeBase64Std(userInfo); } catch { /* keep raw */ }
    const colonIdx = decoded.indexOf(":");
    if (colonIdx >= 0) {
      method = decoded.slice(0, colonIdx);
      password = decoded.slice(colonIdx + 1);
    } else {
      method = decoded;
    }
  } else {
    try {
      const decoded = decodeBase64Std(main);
      const atIdx = decoded.lastIndexOf("@");
      if (atIdx >= 0) {
        const userInfo = decoded.slice(0, atIdx);
        main = decoded.slice(atIdx + 1);
        const colonIdx = userInfo.indexOf(":");
        if (colonIdx >= 0) {
          method = userInfo.slice(0, colonIdx);
          password = userInfo.slice(colonIdx + 1);
        }
      }
    } catch { /* leave method/password empty */ }
  }
  const [host, portStr] = main.split(":");
  return {
    protocol: "shadowsocks",
    tag: fragment || tag,
    server: host || "",
    port: Number.parseInt(portStr || "0", 10) || 0,
    method,
    password,
  };
}

function parseVmess(link: string, tag: string): Outbound | null {
  const body = link.slice("vmess://".length);
  let json: string;
  try { json = decodeBase64Std(body); } catch { return null; }
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(json) as Record<string, unknown>; } catch { return null; }
  const host = String(parsed.add ?? parsed.host ?? "");
  const port = Number.parseInt(String(parsed.port ?? "0"), 10) || 0;
  const uuid = String(parsed.id ?? "");
  const cipher = (String(parsed.scy ?? parsed.type ?? "auto") ||
    "auto") as "auto" | "aes128gcm" | "chacha20poly1305" | "none";
  const tagName = String(parsed.ps ?? tag);
  const networkRaw = String(parsed.net ?? "tcp");
  // Build a fake URLSearchParams for transport parsing so the
  // ws/grpc/xhttp/etc. mapping is shared.
  const params = new URLSearchParams();
  if (networkRaw === "ws") params.set("type", "ws");
  else if (networkRaw === "grpc") params.set("type", "grpc");
  if (parsed.host2) params.set("host", String(parsed.host2));
  else if (parsed.host) params.set("host", String(parsed.host));
  if (parsed.path) params.set("path", String(parsed.path));
  const tlsEnabled = parsed.tls === "tls" || parsed.tls === "reality";
  if (tlsEnabled) params.set("security", String(parsed.tls));
  if (parsed.sni) params.set("sni", String(parsed.sni));
  if (parsed.fp) params.set("fp", String(parsed.fp));
  return {
    protocol: "vmess",
    tag: tagName,
    server: host,
    port,
    uuid,
    alter_id: Number.parseInt(String(parsed.aid ?? "0"), 10) || 0,
    cipher,
    transport: parseTransport(params),
    tls: parseTls(params),
  };
}

function parseHysteria2(link: string, tag: string): Outbound | null {
  // hy2://password@host:port?params#name  (or  hysteria2://)
  const noScheme = link.replace(/^hysteria2:\/\//, "").replace(/^hy2:\/\//, "");
  const hashIdx = noScheme.indexOf("#");
  const fragment = hashIdx >= 0 ? decodeURIComponent(noScheme.slice(hashIdx + 1)) : "";
  const head = hashIdx >= 0 ? noScheme.slice(0, hashIdx) : noScheme;
  const qIdx = head.indexOf("?");
  const tail = qIdx >= 0 ? head.slice(qIdx + 1) : "";
  const main = qIdx >= 0 ? head.slice(0, qIdx) : head;
  const atIdx = main.lastIndexOf("@");
  if (atIdx < 0) return null;
  const password = main.slice(0, atIdx);
  const hostPort = main.slice(atIdx + 1);
  const [host, portStr] = hostPort.split(":");
  const params = new URLSearchParams(tail);
  return {
    protocol: "hysteria2",
    tag: fragment || tag,
    server: host || "",
    port: Number.parseInt(portStr || "0", 10) || 0,
    password: decodeURIComponent(password),
    tls: parseTls(params),
  };
}

function parseTuic(link: string, tag: string): Outbound | null {
  // tuic://uuid:password@host:port?params#name
  const noScheme = link.slice("tuic://".length);
  const hashIdx = noScheme.indexOf("#");
  const fragment = hashIdx >= 0 ? decodeURIComponent(noScheme.slice(hashIdx + 1)) : "";
  const head = hashIdx >= 0 ? noScheme.slice(0, hashIdx) : noScheme;
  const qIdx = head.indexOf("?");
  const tail = qIdx >= 0 ? head.slice(qIdx + 1) : "";
  const main = qIdx >= 0 ? head.slice(0, qIdx) : head;
  const atIdx = main.lastIndexOf("@");
  if (atIdx < 0) return null;
  const userInfo = main.slice(0, atIdx);
  const hostPort = main.slice(atIdx + 1);
  const [host, portStr] = hostPort.split(":");
  const colonIdx = userInfo.indexOf(":");
  if (colonIdx < 0) return null;
  const uuid = userInfo.slice(0, colonIdx);
  const password = userInfo.slice(colonIdx + 1);
  const params = new URLSearchParams(tail);
  const ccRaw = (params.get("congestion_control") || "cubic").toLowerCase();
  const cc = ccRaw === "bbr" ? "bbr" : ccRaw === "new_reno" ? "new_reno" : "cubic";
  return {
    protocol: "tuic",
    tag: fragment || tag,
    server: host || "",
    port: Number.parseInt(portStr || "0", 10) || 0,
    uuid: decodeURIComponent(uuid),
    password: decodeURIComponent(password),
    congestion_control: cc,
    udp_relay_mode: "native",
    tls: parseTls(params),
  };
}

function parseWireguard(_link: string, _tag: string): Outbound | null {
  // WireGuard needs its own Outbound shape (public_key, private_key,
  // reserved, etc.) which the current `Outbound` discriminated union
  // does not have. We refuse it here so the count of `errors` goes
  // up and the UI can show "1 link(s) skipped (wireguard not yet
  // supported)". When the Outbound type gains a `wireguard`
  // variant, this becomes a real implementation.
  return null;
}

// --- Clash YAML parser --------------------------------------------------
//
// The big four share-link protocols are handled above. Clash
// (ClashforWindows, Clash.Meta, mihomo) subscriptions ship as a
// full YAML document. We accept any combination of the following
// transport types:
//
//   tcp / ws / grpc / http / h2
//   xhttp       (Clash Meta)
//   splithttp   (Clash Meta)
//   httpupgrade (Clash Meta)
//
// and the following proxy types:
//
//   ss          → shadowsocks
//   vmess       → vmess
//   vless       → vless
//   trojan      → trojan
//   hysteria2   → hysteria2
//   tuic        → tuic
//
// We deliberately skip http / socks5 / wireguard / ssh — those are
// not outbound protocols our VPN engines can connect to. If a
// subscription contains them, we log nothing and just drop them
// (the user has plenty of working proxies in the same list).
//
// Clash's `name` field becomes the `tag`. We sanitize it to
// `[A-Za-z0-9.-]` and prefix with `sub-<index>-` so it stays
// unique and DB-safe.

type ClashProxy = Record<string, unknown>;

function clashTag(name: unknown, index: number): string {
  const raw = typeof name === "string" ? name : `proxy-${index}`;
  const safe = raw
    .replace(/[^a-zA-Z0-9.-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `sub-${index}-${safe || "out"}`;
}

function toHostList(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === "string" && x.length > 0);
  }
  if (typeof v === "string" && v.length > 0) return [v];
  return [];
}

function parseClashTransport(entry: ClashProxy): Transport {
  const network = String(entry.network ?? "tcp").toLowerCase();
  switch (network) {
    case "ws": {
      const opts = (entry["ws-opts"] ?? {}) as ClashProxy;
      const path = typeof opts.path === "string" ? opts.path : "/";
      const headers = (opts.headers ?? {}) as Record<string, unknown>;
      const host =
        (typeof headers.Host === "string" && headers.Host) ||
        (typeof headers.host === "string" && headers.host) ||
        undefined;
      return {
        kind: "ws",
        path,
        headers: host ? [["Host", host]] : [],
      };
    }
    case "http":
    case "h2": {
      const optsKey = network === "h2" ? "h2-opts" : "http-opts";
      const opts = (entry[optsKey] ?? {}) as ClashProxy;
      return {
        kind: "http",
        host: toHostList(opts.host),
        path: typeof opts.path === "string" ? opts.path : "/",
      };
    }
    case "grpc": {
      const opts = (entry["grpc-opts"] ?? {}) as ClashProxy;
      const sn =
        (typeof opts["grpc-service-name"] === "string" &&
          (opts["grpc-service-name"] as string)) ||
        (typeof opts.serviceName === "string" && (opts.serviceName as string)) ||
        "";
      const t: Transport = { kind: "grpc" };
      if (sn) t.service_name = sn;
      return t;
    }
    case "xhttp": {
      const opts = (entry["xhttp-opts"] ?? {}) as ClashProxy;
      const t: Transport = { kind: "xhttp", host: toHostList(opts.host) };
      if (typeof opts.path === "string" && opts.path) t.path = opts.path;
      if (typeof opts.mode === "string" && opts.mode) t.mode = opts.mode;
      return t;
    }
    case "splithttp": {
      const opts = (entry["splithttp-opts"] ?? {}) as ClashProxy;
      const t: Transport = { kind: "splithttp", host: toHostList(opts.host) };
      if (typeof opts.path === "string" && opts.path) t.path = opts.path;
      if (typeof opts.mode === "string" && opts.mode) t.mode = opts.mode;
      return t;
    }
    case "httpupgrade": {
      const opts = (entry["httpupgrade-opts"] ?? {}) as ClashProxy;
      const t: Transport = {
        kind: "httpupgrade",
        host: toHostList(opts.host),
      };
      if (typeof opts.path === "string" && opts.path) t.path = opts.path;
      else t.path = "/";
      return t;
    }
    case "tcp":
    default:
      return { kind: "tcp" };
  }
}

function parseClashTls(entry: ClashProxy): TlsCfg {
  const enabled = entry.tls === true;
  if (!enabled) {
    return { enabled: false, alpn: [], allow_insecure: false };
  }
  const sni =
    (typeof entry.servername === "string" && entry.servername) ||
    (typeof entry.sni === "string" && entry.sni) ||
    undefined;
  const alpnRaw = entry.alpn;
  const alpn = Array.isArray(alpnRaw)
    ? alpnRaw.filter((x): x is string => typeof x === "string")
    : typeof alpnRaw === "string"
      ? alpnRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const fp =
    (typeof entry.fingerprint === "string" && entry.fingerprint) ||
    (typeof entry["client-fingerprint"] === "string" &&
      (entry["client-fingerprint"] as string)) ||
    undefined;
  const allowInsecure = entry["skip-cert-verify"] === true;
  const realityOpts = (entry["reality-opts"] ?? null) as ClashProxy | null;
  let reality: TlsCfg["reality"];
  if (realityOpts) {
    const pk =
      typeof realityOpts["public-key"] === "string"
        ? (realityOpts["public-key"] as string)
        : typeof realityOpts.publicKey === "string"
          ? (realityOpts.publicKey as string)
          : "";
    const sid =
      typeof realityOpts["short-id"] === "string"
        ? (realityOpts["short-id"] as string)
        : typeof realityOpts.shortId === "string"
          ? (realityOpts.shortId as string)
          : "";
    if (pk || sid) {
      reality = { public_key: pk, short_id: sid };
      const spx = realityOpts["spider-x"];
      if (typeof spx === "string" && spx) reality.spider_x = spx;
    }
  }
  return {
    enabled: true,
    server_name: sni,
    alpn,
    fingerprint: fp,
    allow_insecure: allowInsecure,
    ...(reality ? { reality } : {}),
  };
}

function parseClashProxy(entry: ClashProxy, index: number): Outbound | null {
  const type = String(entry.type ?? "").toLowerCase();
  const server = typeof entry.server === "string" ? entry.server.trim() : "";
  const portRaw = entry.port;
  const port =
    typeof portRaw === "number"
      ? Math.trunc(portRaw)
      : Number.parseInt(String(portRaw ?? "0"), 10) || 0;
  if (!server || port <= 0) return null;
  const tag = clashTag(entry.name, index);
  const transport = parseClashTransport(entry);
  const tls = parseClashTls(entry);

  switch (type) {
    case "vless": {
      const uuid = typeof entry.uuid === "string" ? entry.uuid : "";
      if (!uuid) return null;
      const flow =
        typeof entry.flow === "string" && entry.flow ? entry.flow : undefined;
      const out: Outbound = {
        protocol: "vless",
        tag,
        server,
        port,
        uuid,
        transport,
        tls,
      };
      if (flow) (out as { flow?: string }).flow = flow;
      return out;
    }
    case "vmess": {
      const uuid = typeof entry.uuid === "string" ? entry.uuid : "";
      if (!uuid) return null;
      const aidRaw = entry.alterId ?? entry.aid ?? 0;
      const alterId =
        typeof aidRaw === "number"
          ? Math.trunc(aidRaw)
          : Number.parseInt(String(aidRaw), 10) || 0;
      const cipherRaw = String(entry.cipher ?? "auto").toLowerCase();
      const cipher: VmessOut["cipher"] =
        cipherRaw === "aes-128-gcm"
          ? "aes128gcm"
          : cipherRaw === "chacha20-poly1305"
            ? "chacha20poly1305"
            : cipherRaw === "none"
              ? "none"
              : "auto";
      return {
        protocol: "vmess",
        tag,
        server,
        port,
        uuid,
        alter_id: alterId,
        cipher,
        transport,
        tls,
      };
    }
    case "trojan": {
      const password = typeof entry.password === "string" ? entry.password : "";
      if (!password) return null;
      return {
        protocol: "trojan",
        tag,
        server,
        port,
        password,
        transport,
        tls,
      };
    }
    case "ss": {
      const method = typeof entry.cipher === "string" ? entry.cipher : "";
      const password = typeof entry.password === "string" ? entry.password : "";
      if (!method || !password) return null;
      const out: Outbound = {
        protocol: "shadowsocks",
        tag,
        server,
        port,
        method,
        password,
      };
      if (typeof entry.plugin === "string" && entry.plugin) {
        out.plugin = entry.plugin;
        if (entry["plugin-opts"] != null) {
          out.plugin_opts =
            typeof entry["plugin-opts"] === "string"
              ? entry["plugin-opts"]
              : JSON.stringify(entry["plugin-opts"]);
        }
      }
      return out;
    }
    case "hysteria2": {
      const password = typeof entry.password === "string" ? entry.password : "";
      if (!password) return null;
      const obfsType =
        typeof entry.obfs === "string" && entry.obfs ? entry.obfs : "";
      const obfsPw =
        typeof entry["obfs-password"] === "string"
          ? entry["obfs-password"]
          : "";
      const out: Outbound = {
        protocol: "hysteria2",
        tag,
        server,
        port,
        password,
        tls,
      };
      if (obfsType && obfsPw) {
        out.obfs = { type: obfsType, password: obfsPw };
      }
      return out;
    }
    case "tuic": {
      const uuid = typeof entry.uuid === "string" ? entry.uuid : "";
      const password = typeof entry.password === "string" ? entry.password : "";
      if (!uuid || !password) return null;
      const ccRaw = String(
        entry["congestion-controller"] ?? "cubic",
      ).toLowerCase();
      const congestion_control: TuicOut["congestion_control"] =
        ccRaw === "bbr"
          ? "bbr"
          : ccRaw === "new_reno"
            ? "new_reno"
            : "cubic";
      return {
        protocol: "tuic",
        tag,
        server,
        port,
        uuid,
        password,
        congestion_control,
        udp_relay_mode: "native",
        tls,
      };
    }
    // Unsupported by the VPN engines: http (forward proxy), socks5
    // (forward proxy), wireguard (no Outbound variant), ssh, etc.
    // Drop silently — the rest of the proxies are usually fine.
    default:
      return null;
  }
}

function looksLikeClashYaml(text: string): boolean {
  // Cheap sniff before paying for `yaml.load` (which is O(n) and
  // can be slow on big documents). A real Clash config always
  // has at least one of `port:`, `mixed-port:`, `proxies:`, or
  // `proxy-groups:` at the start of a line.
  return /(^|\n)\s*(mixed-port|socks-port|port|proxies|proxy-groups|proxy-providers)\s*:/m.test(
    text,
  );
}

function parseClashYaml(text: string): Outbound[] | null {
  let parsed: unknown;
  try {
    // `JSON_SCHEMA` accepts standard YAML 1.2 — same as Clash
    // (Clash for Windows, mihomo) — and avoids the YAML 1.1
    // octal/sexagesimal footguns. We don't need the full type
    // machinery; `unknown` is fine because we re-validate field
    // types at every read.
    parsed = yamlLoad(text, { schema: JSON_SCHEMA });
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const root = parsed as ClashProxy;
  const proxies = root.proxies;
  if (!Array.isArray(proxies) || proxies.length === 0) return null;
  const out: Outbound[] = [];
  for (let i = 0; i < proxies.length; i++) {
    const entry = proxies[i];
    if (!entry || typeof entry !== "object") continue;
    const ob = parseClashProxy(entry as ClashProxy, i);
    if (ob) out.push(ob);
  }
  return out.length > 0 ? out : null;
}

function parseLine(line: string, index: number): Outbound | null {
  const tag = tagFor(line, index, "");
  if (line.startsWith("vless://")) return parseVless(line, tag);
  if (line.startsWith("trojan://")) return parseTrojan(line, tag);
  if (line.startsWith("ss://")) return parseShadowsocks(line, tag);
  if (line.startsWith("vmess://")) return parseVmess(line, tag);
  if (line.startsWith("hysteria2://") || line.startsWith("hy2://")) return parseHysteria2(line, tag);
  if (line.startsWith("tuic://")) return parseTuic(line, tag);
  if (line.startsWith("wireguard://")) return parseWireguard(line, tag);
  return null;
}

export function parseSubscriptionBody(body: string, contentType?: string): ParseResult {
  const trimmed = body.trim();
  if (!trimmed) return { outbounds: [], errors: 0 };

  // 1) JSON body (outbound array or {outbounds:[...]}).
  const jsonOutbounds = maybeJsonArray(trimmed);
  if (jsonOutbounds) {
    return { outbounds: jsonOutbounds, errors: 0 };
  }

  // 2) Decode base64 if it looks like it.
  const decoded = looksLikeBase64(trimmed) ? base64ToText(trimmed) : null;
  const text = decoded ?? trimmed;

  // 3) Try JSON in the decoded text as well.
  const decodedJson = decoded ? maybeJsonArray(text) : null;
  if (decodedJson) {
    return { outbounds: decodedJson, errors: 0 };
  }

  // 4) Clash YAML (ClashforWindows / mihomo / Clash Meta). The
  //    body is always plain text — never base64-wrapped — and
  //    always has a top-level `proxies:` array (which may be
  //    empty for a token that has no live servers). We accept
  //    any document that has a non-empty `proxies:`, regardless
  //    of the upstream Content-Type.
  if (looksLikeClashYaml(text)) {
    const yamlOutbounds = parseClashYaml(text);
    if (yamlOutbounds) {
      return { outbounds: yamlOutbounds, errors: 0 };
    }
  }

  // 5) Line-by-line URI list.
  const outbounds: Outbound[] = [];
  let errors = 0;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("#") || raw.startsWith("//")) continue;
    if (!raw.includes("://")) continue;
    const ob = parseLine(raw, i);
    if (ob) outbounds.push(ob);
    else errors += 1;
  }
  if (outbounds.length === 0) {
    return {
      outbounds: [],
      errors: 1,
      preview: text.slice(0, 240),
    };
  }
  return { outbounds, errors };
}
