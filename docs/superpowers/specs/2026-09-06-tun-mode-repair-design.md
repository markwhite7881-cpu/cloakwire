# TUN Mode Architecture and Repair Design

**Date:** 2026-09-06  
**Status:** Approved  
**Scope:** Windows Wintun routing, DNS lifecycle, and runtime configuration generation for Sing-box and Xray engines.

---

## 1. Context and Problem Statement

Cloakwire provides VPN-like full system traffic tunneling via TUN mode powered by the kernel-level Wintun driver on Windows. Users experienced two distinct failure modes depending on the active engine:
1. **Sing-box Engine:** Activating TUN mode completely severed internet connectivity ("обрубает интернет"). Connections to local services and web domains stalled indefinitely.
2. **Xray Engine:** Activating TUN mode left internet traffic unrouted through the proxy (country/IP remained unchanged) or resulted in DNS timeouts and packet blackholing.

### Root Cause Analysis

#### Sing-box Root Causes
1. **Missing `route.auto_detect_interface: true`:**  
   In `src-tauri/src/config/mod.rs`, the `tun` inbound enables `"auto_route": true`. According to sing-box 1.12+ specifications, whenever `auto_route` is enabled on Windows or Linux, `route.auto_detect_interface: true` is mandatory. Without it, Sing-box cannot discover the physical default interface (Ethernet/Wi-Fi). When default routes (`0.0.0.0/0`) are bound to Wintun, Sing-box's own outbound sockets to the proxy server (`server:port`) loop back into the TUN adapter, causing immediate connection failure.
2. **DNS Hijacking Deadlock and Missing Direct Detour:**  
   In `build_dns`, the `local` DNS server lacked `"detour": "direct"`, and `build_route` prepends `{ "action": "hijack-dns", "port": [53] }` with `"final": "remote"`. Every DNS query on port 53 was hijacked and sent to `remote` (`1.1.1.1:53` via proxy). If the proxy transport (e.g. VLESS Reality over gRPC) drops or delays port 53 traffic, all system DNS queries time out, blackholing all browser and application traffic.

#### Xray Root Causes
1. **Missing Inbound Catch-All Route for TUN Traffic:**  
   In `src-tauri/src/xray/routing.rs`, the only rule added for `cloakwire-managed-tun` was `{ "type": "field", "inboundTag": ["cloakwire-managed-tun"], "port": "53", "outboundTag": "cloakwire-managed-dns" }`. Non-DNS packets from Wintun had no explicit route to `"proxy"` or to the active balancer (e.g. `auto-proxy`). Packets fell through or matched unintended rules, causing packets to be dropped or unrouted.
2. **DNS Routing Loop on Windows:**  
   In `src-tauri/src/xray/windows_tun.rs`, `setup_xray_windows_tun` added `/32` physical gateway bypass routes only for `server_ips`. It assigned `1.1.1.1` and `8.8.8.8` as DNS on Wintun and added split default routes (`0.0.0.0/1` and `128.0.0.0/1`) to Wintun (`172.19.0.1`). When Xray issued direct DNS queries to `1.1.1.1`, the Windows kernel routed them back into Wintun (`0.0.0.0/1`), creating an infinite routing loop.

---

## 2. Architecture and Technical Design

### Component A: Sing-box Engine (`src-tauri/src/config/mod.rs`)

#### 1. Outbound Interface Auto-Detection
In `build_route(&settings)`:
- Emitted JSON `route` must always include:
  ```json
  "auto_detect_interface": true
  ```
- This binds all Sing-box outbound sockets (including `direct` and proxy dialers) to the physical gateway adapter determined at runtime by Sing-box's IP Helper integration.

#### 2. Robust DNS Architecture
In `build_dns(&dns_opts, &routing_opts)`:
1. `local` DNS resolver configuration:
   ```json
   {
     "tag": "local",
     "type": "udp",
     "server": "1.1.1.1",
     "detour": "direct"
   }
   ```
2. `remote` DNS resolver configuration with fallback:
   ```json
   {
     "tag": "remote",
     "type": "tcp",
     "server": "1.1.1.1",
     "detour": "proxy"
   }
   ```
3. DNS routing rules (`dns.rules`):
   - Direct domains and private IPs route to `local` with `detour: direct`.
   - Proxy server address domains resolve via `local` to avoid startup deadlocks.
   - User-defined bypass rules (e.g. RU domains, direct processes) resolve via `local`.
   - General proxy traffic resolves via `remote`.

---

### Component B: Xray Engine

#### 1. Inbound TUN Routing Injection (`src-tauri/src/xray/routing.rs`)
In `merge_routing_with_tun`:
- When `tun_active` is true, after specific bypass rules (private IP, bittorrent, ru-bypass), inject a catch-all TUN routing rule:
  - If a balancer exists (`balancer_tags` contains an active balancer like `auto-proxy`), route:
    ```json
    {
      "type": "field",
      "inboundTag": ["cloakwire-managed-tun"],
      "network": "tcp,udp",
      "balancerTag": "<active_balancer_tag>"
    }
    ```
  - If no balancer exists, route to primary proxy outbound tag (`proxy` or `outbound_tags[0]`):
    ```json
    {
      "type": "field",
      "inboundTag": ["cloakwire-managed-tun"],
      "network": "tcp,udp",
      "outboundTag": "<proxy_tag>"
    }
    ```
- This guarantees all non-bypassed IPv4/IPv6 packets entering Wintun are forwarded through the proxy pipeline.

#### 2. Windows Wintun Route Table & DNS Loop Prevention (`src-tauri/src/xray/windows_tun.rs`)
In `setup_xray_windows_tun`:
1. Extract both proxy `server_ips` AND upstream DNS IPs (`1.1.1.1`, `8.8.8.8`, or custom DNS IPs from config).
2. For every IP in `[server_ips, dns_ips]`:
   - Add a `/32` host bypass route via physical default gateway:
     `route add <ip> mask 255.255.255.255 <physical_gateway_ip> metric 1 if <physical_if_index>`
   - Record in `added_routes: Vec<RouteRecord>`.
3. Set Wintun static IP (`172.19.0.2/30`) and DNS (`1.1.1.1`, `8.8.8.8`).
4. Add split default routes (`0.0.0.0/1` and `128.0.0.0/1`) pointing to `172.19.0.1 if <wintun_if_index>`.
5. On disconnect, `teardown_xray_windows_tun` removes all recorded `/32` routes and deletes split default routes cleanly.

---

## 3. Compatibility and Edge Cases

1. **Dual-Stack IPv6:**  
   If IPv6 is enabled, similar route isolation applies; when `block_ipv6` is true (default), reject rules in both engines drop IPv6 leaks before traversing Wintun.
2. **Multiple Proxy Nodes / CDNs:**  
   `resolve_server_ips` resolves all A records for domain-based servers. All returned IPv4 addresses receive `/32` bypass routes.
3. **Dirty Exit Recovery:**  
   `teardown_xray_windows_tun_unconditional` cleans up leftover `0.0.0.0/1` and `128.0.0.0/1` routes during app startup if a previous crash occurred.

---

## 4. Verification Plan

### Automated Tests
1. `cargo test --lib config::tests`: Verify `auto_detect_interface: true` and `detour: direct` in Sing-box config generation.
2. `cargo test --lib xray::routing::tests`: Verify injection of catch-all TUN rule for `cloakwire-managed-tun`.
3. `cargo test --lib xray::windows_tun::tests`: Verify DNS server IP extraction and bypass route recording.

### Manual Verification on Windows Host
1. Connect via Sing-box in TUN mode: verify ping, DNS resolution (`nslookup google.com`), and IP change on `2ip.io`.
2. Connect via Xray in TUN mode: verify Wintun routes (`route print 0.0.0.0`), DNS resolution, and IP change on `2ip.io`.
3. Disconnect: verify routing table returns to original state with no orphan routes.
