package app.cloakwire.client.vpn

import android.content.Context
import android.content.pm.PackageManager

internal object AndroidProfilePreflight {
  private const val TIMEOUT_MS = 10_000L
  private val native = BoundedNativeProfileCheck()
  val starts = PendingProfileStarts()

  fun prepare(context: Context, raw: String, engine: String, apps: String, mode: String): String {
    val policy = AndroidEngineConfig.appPolicy(apps, mode, context.packageName)
    require(policy.allowedPackages.isEmpty() || policy.allowedPackages.any { pkg ->
      try {
        @Suppress("DEPRECATION")
        context.packageManager.getApplicationInfo(pkg, 0)
        true
      } catch (_: PackageManager.NameNotFoundException) { false }
    }) { "No selected application is installed" }
    return if (engine == CloakwireVpnService.ENGINE_XRAY) {
      AndroidEngineConfig.xray(raw, CloakwireVpnService.logFile(context).absolutePath)
    } else {
      AndroidEngineConfig.singBox(raw, apps, mode, context.packageName, CloakwireVpnService.singboxLogFile(context).absolutePath)
    }
  }

  fun check(context: Context, config: String, engine: String) {
    val muted = AndroidEngineConfig.forCheck(config, engine)
    if (engine == CloakwireVpnService.ENGINE_XRAY) {
      XrayEngine.checkConfig(context, muted, TIMEOUT_MS)
    } else {
      native.check(TIMEOUT_MS) { SingBoxEngine.checkConfig(context, muted) }
    }
  }
}
