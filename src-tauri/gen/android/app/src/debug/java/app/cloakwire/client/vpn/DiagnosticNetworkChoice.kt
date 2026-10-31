package app.cloakwire.client.vpn

/** Prefer the active non-VPN network; an ambiguous fallback is not a safe route witness. */
internal fun <T> diagnosticNetworkChoice(active: T?, physical: List<T>): T? =
    physical.firstOrNull { it == active } ?: physical.singleOrNull()
