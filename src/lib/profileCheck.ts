const PROFILE_CHECK_CODES = [
  "profile_check_dns",
  "profile_check_ruleset",
  "profile_check_unsupported",
  "profile_check_invalid",
  "profile_check_unavailable",
  "profile_check_timeout",
  "profile_check_failed",
  "profile_check_cancelled",
] as const;

export type ProfileCheckCode = (typeof PROFILE_CHECK_CODES)[number];

/** Only safe backend categories cross the profile-check UI boundary. */
export function profileCheckCode(error: unknown): ProfileCheckCode | null {
  const object = error && typeof error === "object" ? error as { kind?: unknown; message?: unknown } : null;
  const candidates = [object?.kind, object?.message, typeof error === "string" ? error : null];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const token = candidate.match(/(?:^|[^a-zA-Z0-9_])(profile_check_[a-zA-Z0-9_]+)(?=$|[^a-zA-Z0-9_])/)?.[1];
    if (!token) continue;
    return PROFILE_CHECK_CODES.includes(token as ProfileCheckCode)
      ? token as ProfileCheckCode
      : "profile_check_failed";
  }
  return null;
}

export function isProfileCheckCancelled(error: unknown): boolean {
  return profileCheckCode(error) === "profile_check_cancelled";
}

/** Keep existing non-profile errors useful, preserving structured command kinds. */
export function humanError(error: unknown): string {
  const code = profileCheckCode(error);
  if (code) return code;
  if (error && typeof error === "object") {
    const { kind, message } = error as { kind?: unknown; message?: unknown };
    if (typeof message === "string") {
      if (typeof kind === "string") return `${kind}: ${message}`;
      return message || (error instanceof Error ? error.name : String(error));
    }
  }
  return String(error);
}

export function profileCheckDetails(error: unknown, t: (key: string) => string) {
  const code = profileCheckCode(error);
  if (!code || code === "profile_check_cancelled") return null;
  const category = code.slice("profile_check_".length);
  const title = t("profileCheck.title");
  const reason = t(`profileCheck.${category}.reason`);
  const action = t(`profileCheck.${category}.action`);
  // The copied report is rebuilt from trusted translations and an allowlisted
  // code. Never include the exception, provider JSON, URLs, or core stderr.
  return { code, title, reason, action, report: `${title}\n${reason}\n${action}\n${code}` };
}
