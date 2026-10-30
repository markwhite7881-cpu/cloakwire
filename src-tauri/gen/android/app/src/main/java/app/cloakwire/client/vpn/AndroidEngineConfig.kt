package app.cloakwire.client.vpn

import org.json.JSONArray
import org.json.JSONObject

/** Pure preparation shared by the checker and the runtime. Never touches active files. */
internal object AndroidEngineConfig {
  /** Ensure provider sing-box bundles have an Android TUN and app policy. */
  fun singBox(raw: String, appsJson: String, appsMode: String, ownPackage: String, logPath: String): String {
    val root = JSONObject(raw)
    root.getJSONArray("outbounds")
    val inbounds = root.optJSONArray("inbounds") ?: JSONArray().also {
      root.put("inbounds", it)
    }
    var existing: JSONObject? = null
    for (i in 0 until inbounds.length()) {
      val candidate = inbounds.optJSONObject(i) ?: continue
      if (candidate.optString("type") == "tun") {
        existing = candidate
        break
      }
    }
    val tun = existing ?: JSONObject().also { inbounds.put(it) }
    // A provider bundle may carry a desktop-oriented TUN. Preserve its tag
    // (route rules can reference it), but normalize every Android-owned field.
    tun.put("type", "tun")
    if (tun.optString("tag").isBlank()) tun.put("tag", "tun-in")
    tun.remove("inet4_address")
    tun.remove("inet6_address")
    tun.put("address", JSONArray().put("172.19.0.1/30"))
    tun.put("auto_route", true)
    tun.put("strict_route", false)
    tun.put("stack", "gvisor")
    tun.put("mtu", 9000)
    tun.put("endpoint_independent_nat", false)
    tun.put("udp_timeout", "5m")
    tun.put("interface_name", "singbox-tun")

    tun.remove("include_package")
    tun.remove("exclude_package")
    val policy = XrayAppRoutingPolicy.create(parseAppList(appsJson), appsMode, ownPackage)
    if (policy.allowedPackages.isNotEmpty()) {
      tun.put("include_package", JSONArray().also { arr ->
        policy.allowedPackages.forEach { arr.put(it) }
      })
    } else {
      tun.put("exclude_package", JSONArray().also { arr ->
        policy.disallowedPackages.forEach { arr.put(it) }
      })
    }

    // Ensure route has hijack-dns and private IP bypass, and clean up any legacy rules
    val route = root.optJSONObject("route") ?: JSONObject().also { root.put("route", it) }
    val rawRules = route.optJSONArray("rules") ?: JSONArray().also { route.put("rules", it) }
    val newRules = JSONArray()
    var hasHijack = false
    var hasPrivate = false

    // Clean existing rules
    for (i in 0 until rawRules.length()) {
      val r = rawRules.optJSONObject(i) ?: continue
      if (r.optString("network") == "dns") {
        r.remove("network")
        r.put("action", "hijack-dns")
        r.put("port", JSONArray().put(53))
        hasHijack = true
        newRules.put(r)
        continue
      }
      if (r.optString("action") == "hijack-dns") hasHijack = true
      if (r.optBoolean("ip_is_private")) hasPrivate = true
      newRules.put(r)
    }

    // Prepend hijack-dns and private bypass if missing
    val finalRules = JSONArray()
    if (!hasHijack) {
      finalRules.put(JSONObject().put("action", "hijack-dns").put("port", JSONArray().put(53)))
    }
    if (!hasPrivate) {
      finalRules.put(JSONObject().put("action", "route").put("ip_is_private", true).put("outbound", "direct"))
    }
    for (i in 0 until newRules.length()) {
      finalRules.put(newRules.get(i))
    }
    route.put("rules", finalRules)

    val log = root.optJSONObject("log") ?: JSONObject().also { root.put("log", it) }
    log.put("output", logPath)
    if (!log.has("level")) log.put("level", "info")
    return root.toString()
  }

  fun xray(raw: String, logPath: String): String {
    val root = JSONObject(raw)
    root.getJSONArray("outbounds")
    val log = root.optJSONObject("log") ?: JSONObject().also { root.put("log", it) }
    log.put("output", logPath)
    log.put("loglevel", log.optString("loglevel", "info"))
    return root.toString()
  }

  /** Disable diagnostic sinks only; route/DNS/provider fields remain identical. */
  fun forCheck(config: String, engine: String): String {
    val root = JSONObject(config)
    val log = root.optJSONObject("log") ?: JSONObject().also { root.put("log", it) }
    log.remove("output")
    if (engine == "xray") {
      log.put("loglevel", "none")
      log.put("access", "none")
      log.put("error", "none")
      log.put("dnsLog", false)
    } else {
      log.put("disabled", true)
    }
    return root.toString()
  }

  fun appPolicy(appsJson: String, mode: String, ownPackage: String): XrayAppRoutingPolicy =
    XrayAppRoutingPolicy.create(parseAppList(appsJson), mode, ownPackage)

  private fun parseAppList(raw: String): List<String> {
    val apps = JSONArray(raw)
    return List(apps.length()) { apps.getString(it) }
  }
}
