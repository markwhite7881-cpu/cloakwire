import { describe, expect, it } from "vitest";
import { TauriCommandError } from "./api";
import { getTranslation, LOCALES } from "./i18n/i18n";
import { humanError, profileCheckCode, profileCheckDetails } from "./profileCheck";

describe("profile check error boundary", () => {
  it("uses structured kind before an unsafe message", () => {
    const error = new TauriCommandError("profile_check_dns", 'secret config: {"password":"hidden"}');
    expect(humanError(error)).toBe("profile_check_dns");
    expect(profileCheckCode({ kind: "profile_check_ruleset", message: "profile_check_dns secret" })).toBe("profile_check_ruleset");
  });

  it("accepts Android rejection tokens and strips all additional diagnostics", () => {
    expect(humanError(new Error("invoke rejected: profile_check_unsupported; password=hidden"))).toBe("profile_check_unsupported");
    expect(humanError("profile_check_timeout: https://provider.example/private-token")).toBe("profile_check_timeout");
  });

  it("sanitizes unknown profile check categories to a safe generic failure", () => {
    expect(humanError({ kind: "profile_check_new_reason", message: "secret" })).toBe("profile_check_failed");
    expect(profileCheckCode("profile_check_dns_extra: secret")).toBe("profile_check_failed");
  });

  it("preserves normal command and network errors", () => {
    expect(humanError(new TauriCommandError("io", "Access denied"))).toBe("io: Access denied");
    expect(humanError(new Error("Network unavailable"))).toBe("Network unavailable");
    expect(profileCheckCode("Connection refused")).toBeNull();
  });

  it.each(["en", "ru", "zh-CN"] as const)("provides a localized reason, next step, and safe report for every category in %s", (locale) => {
    const categories = ["dns", "ruleset", "unsupported", "invalid", "unavailable", "timeout", "failed"];
    for (const category of categories) {
      const details = profileCheckDetails(`profile_check_${category}: password=hidden`, (key) => getTranslation(locale, key));
      expect(details).not.toBeNull();
      expect(details!.reason).toBe((LOCALES[locale] as any).profileCheck[category].reason);
      expect(details!.action).toBe((LOCALES[locale] as any).profileCheck[category].action);
      expect(details!.reason.length).toBeGreaterThan(0);
      expect(details!.action.length).toBeGreaterThan(0);
      expect(details!.report).toContain(`profile_check_${category}`);
      expect(details!.report).not.toContain("password");
      expect(details!.report).not.toContain("hidden");
    }
  });
});

describe("profile check cancellation", () => {
  it("preserves the cancellation token without presenting it as a failed check", () => {
    const cancelled = new TauriCommandError("profile_check_cancelled", "internal details");
    expect(profileCheckCode(cancelled)).toBe("profile_check_cancelled");
    expect(humanError(cancelled)).toBe("profile_check_cancelled");
    expect(profileCheckDetails(cancelled, (key) => getTranslation("en", key))).toBeNull();
  });
});
