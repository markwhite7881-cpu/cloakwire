package app.cloakwire.client.vpn

/**
 * Sanitizes a single line of xray stdout/stderr before it reaches
 * [VpnEvents] or the WebView.
 *
 * Goals:
 *  - never let a provider URL, share link, UUID, password, or base64
 *    key fingerprint leave the engine boundary;
 *  - drop share-link lines entirely (vmess://, vless://, trojan://,
 *    ss://, hysteria://);
 *  - keep the bulk of normal sing-box/xray log lines readable.
 *
 * The redactor is intentionally a pure helper. No allocations beyond
 * the resulting String or the dropped result.
 */
internal object XrayLogRedactor {

  private const val REDACTED_UUID = "[REDACTED-UUID]"
  private const val REDACTED_KEY = "[REDACTED-KEY]"
  private const val REDACTED_PASSWORD = "[REDACTED-PASSWORD]"

  // Share-link schemes. Whole line is dropped when matched.
  private val SHARE_LINK = Regex(
    """(?:vmess|vless|trojan|ss|hysteria|hy|hy2)://[^\s'"]+""",
    RegexOption.IGNORE_CASE,
  )

  // 8-4-4-4-12 hex groups, lowercase or uppercase. Standard UUID
  // shape used by VLESS/Trojan client UUIDs. We keep the regex strict
  // so we don't redact random 32-char hex sequences.
  private val UUID = Regex(
    """\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b""",
  )

  // Base64-like long random tokens. VLESS Reality keys / Trojan
  // passwords / etc. We only redact tokens of 24+ chars that look
  // base64 (alphabet + length), to avoid clobbering normal text.
  private val BASE64_KEY = Regex(
    """\b[A-Za-z0-9+/]{24,}={0,2}\b""",
  )

  // password= / pass= key=value fields. Only matches keys that
  // explicitly name a password — uuid / id are redacted as UUIDs
  // by the UUID pattern, not as a password.
  private val PASSWORD_FIELD = Regex(
    """(?i)\b(pass(word)?)\s*[:=]\s*("([^"]*)"|'([^']*)'|[^\s,;]+)""",
  )

  /**
   * Redact a single log line. Returns the redacted line, or `null`
   * if the line should be dropped entirely (e.g. contains a share
   * link).
   */
  fun redact(line: String): String? {
    if (line.isEmpty()) return line
    if (SHARE_LINK.containsMatchIn(line)) return null

    var out = line
    out = UUID.replace(out, REDACTED_UUID)
    out = BASE64_KEY.replace(out, REDACTED_KEY)
    out = PASSWORD_FIELD.replace(out) { match ->
      val key = match.groupValues[1]
      val hadDoubleQuotes = match.groupValues[3].isNotEmpty()
      val hadSingleQuotes = match.groupValues[4].isNotEmpty()
      val replacement = when {
        hadDoubleQuotes -> "\"$REDACTED_PASSWORD\""
        hadSingleQuotes -> "'$REDACTED_PASSWORD'"
        else -> REDACTED_PASSWORD
      }
      "$key=$replacement"
    }
    return out
  }
}
