package app.cloakwire.client.vpn

/**
 * Resolves the mutually exclusive Android VPN allow/deny application lists.
 *
 * The VPN owner is implicitly excluded in include mode because it is absent
 * from the allow-list. In exclude/all mode it must be present in the deny-list
 * so Xray and the protected dialer cannot feed their sockets back into TUN.
 */
internal data class XrayAppRoutingPolicy(
  val allowedPackages: List<String>,
  val disallowedPackages: List<String>,
) {
  companion object {
    fun create(
      packages: List<String>,
      mode: String,
      ownPackage: String,
    ): XrayAppRoutingPolicy {
      val selected = packages
        .asSequence()
        .map(String::trim)
        .filter(String::isNotEmpty)
        .filterNot { it == ownPackage }
        .distinct()
        .toList()

      if (mode == "include") {
        require(selected.isNotEmpty()) {
          "Select at least one app for include mode"
        }
        return XrayAppRoutingPolicy(
          allowedPackages = selected,
          disallowedPackages = emptyList(),
        )
      }

      return XrayAppRoutingPolicy(
        allowedPackages = emptyList(),
        disallowedPackages = (selected + ownPackage).distinct(),
      )
    }
  }
}
