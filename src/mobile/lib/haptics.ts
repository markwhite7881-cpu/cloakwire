/**
 * Trigger light haptic vibration feedback on devices that support it
 * (Android WebView navigator.vibrate).
 */
export function triggerHaptic(type: "light" | "medium" | "heavy" | "selection" = "light") {
  if (typeof window === "undefined" || !("vibrate" in navigator)) return;
  try {
    switch (type) {
      case "selection":
        navigator.vibrate(12);
        break;
      case "light":
        navigator.vibrate(20);
        break;
      case "medium":
        navigator.vibrate(40);
        break;
      case "heavy":
        navigator.vibrate([25, 40, 25]);
        break;
    }
  } catch {
    // Ignore environments where vibration is blocked or unsupported
  }
}
