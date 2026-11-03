import { vpnSetAccentTheme } from "./vpn";

export type AccentId = "emerald" | "cyan" | "violet" | "amber" | "rose" | "azure" | "indigo" | "coral" | "lime" | "fuchsia" | "slate";

export interface AccentDefinition {
  id: AccentId;
  label: string;
  colorHex: string;
  hslValue: string;
  glowRgb: string;
  fromRgb: string;
  toRgb: string;
  badgeText: string;
  lightInk: string;
  gradientClass: string;
}

export const ACCENTS: AccentDefinition[] = [
  {
    id: "emerald",
    lightInk: "#047857",
    label: "Emerald",
    colorHex: "#10b981",
    hslValue: "142.1 76.2% 45%",
    glowRgb: "16, 185, 129",
    fromRgb: "16, 185, 129",
    toRgb: "45, 212, 191",
    badgeText: "#34d399",
    gradientClass: "from-emerald-500 to-teal-400",
  },
  {
    id: "cyan",
    lightInk: "#0e7490",
    label: "Cyan",
    colorHex: "#06b6d4",
    hslValue: "189 94% 48%",
    glowRgb: "6, 182, 212",
    fromRgb: "6, 182, 212",
    toRgb: "56, 189, 248",
    badgeText: "#22d3ee",
    gradientClass: "from-cyan-500 to-sky-400",
  },
  {
    id: "violet",
    lightInk: "#6d28d9",
    label: "Violet",
    colorHex: "#8b5cf6",
    hslValue: "262 83% 58%",
    glowRgb: "139, 92, 246",
    fromRgb: "139, 92, 246",
    toRgb: "192, 132, 252",
    badgeText: "#a78bfa",
    gradientClass: "from-violet-500 to-purple-400",
  },
  {
    id: "amber",
    lightInk: "#92400e",
    label: "Amber",
    colorHex: "#f59e0b",
    hslValue: "38 92% 50%",
    glowRgb: "245, 158, 11",
    fromRgb: "245, 158, 11",
    toRgb: "250, 204, 21",
    badgeText: "#fbbf24",
    gradientClass: "from-amber-500 to-yellow-400",
  },
  {
    id: "rose",
    lightInk: "#be123c",
    label: "Rose",
    colorHex: "#f43f5e",
    hslValue: "349 89% 60%",
    glowRgb: "244, 63, 94",
    fromRgb: "244, 63, 94",
    toRgb: "251, 113, 133",
    badgeText: "#fb7185",
    gradientClass: "from-rose-500 to-pink-400",
  },
  {
    id: "azure",
    label: "Azure",
    colorHex: "#38bdf8",
    hslValue: "199 90% 60%",
    glowRgb: "56, 189, 248",
    fromRgb: "56, 189, 248",
    toRgb: "125, 211, 252",
    badgeText: "#7dd3fc",
    lightInk: "#0369a1",
    gradientClass: "from-sky-500 to-sky-400",
  },
  {
    id: "indigo",
    label: "Indigo",
    colorHex: "#818cf8",
    hslValue: "235 89% 74%",
    glowRgb: "129, 140, 248",
    fromRgb: "129, 140, 248",
    toRgb: "165, 180, 252",
    badgeText: "#a5b4fc",
    lightInk: "#4338ca",
    gradientClass: "from-indigo-500 to-indigo-400",
  },
  {
    id: "coral",
    label: "Coral",
    colorHex: "#fb806b",
    hslValue: "9 95% 70%",
    glowRgb: "251, 128, 107",
    fromRgb: "251, 128, 107",
    toRgb: "253, 163, 145",
    badgeText: "#fda391",
    lightInk: "#a93929",
    gradientClass: "from-orange-500 to-orange-400",
  },
  {
    id: "lime",
    label: "Lime",
    colorHex: "#a3e635",
    hslValue: "83 78% 55%",
    glowRgb: "163, 230, 53",
    fromRgb: "163, 230, 53",
    toRgb: "190, 242, 100",
    badgeText: "#bef264",
    lightInk: "#4d6b0b",
    gradientClass: "from-lime-500 to-lime-400",
  },
  {
    id: "fuchsia",
    label: "Fuchsia",
    colorHex: "#e879f9",
    hslValue: "292 91% 73%",
    glowRgb: "232, 121, 249",
    fromRgb: "232, 121, 249",
    toRgb: "240, 171, 252",
    badgeText: "#f0abfc",
    lightInk: "#a21caf",
    gradientClass: "from-fuchsia-500 to-fuchsia-400",
  },
  {
    id: "slate",
    label: "Slate",
    colorHex: "#94a3b8",
    hslValue: "215 20% 65%",
    glowRgb: "148, 163, 184",
    fromRgb: "148, 163, 184",
    toRgb: "203, 213, 225",
    badgeText: "#cbd5e1",
    lightInk: "#475569",
    gradientClass: "from-slate-500 to-slate-400",
  },
];

const ACCENT_STORAGE_KEY = "cloakwire:accent";
const OLED_STORAGE_KEY = "cloakwire:oled";

export function loadSavedAccent(): AccentId {
  try {
    if (typeof localStorage !== "undefined") {
      const val = localStorage.getItem(ACCENT_STORAGE_KEY);
      if (val && ACCENTS.some((a) => a.id === val)) {
        return val as AccentId;
      }
    }
  } catch {
    // fallback
  }
  return "emerald";
}

export function loadSavedOled(): boolean {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem(OLED_STORAGE_KEY) === "1";
    }
  } catch {
    return false;
  }
  return false;
}

export function applyAccentTheme(accent: AccentId, oled: boolean): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-accent", accent);
  root.setAttribute("data-oled", oled ? "true" : "false");
  if (oled) {
    root.classList.add("oled");
  } else {
    root.classList.remove("oled");
  }

  const def = ACCENTS.find((a) => a.id === accent) || ACCENTS[0];
  root.style.setProperty("--accent-dynamic-hsl", def.hslValue);
  root.style.setProperty("--accent-glow-rgb", def.glowRgb);
  root.style.setProperty("--accent-rgb", def.glowRgb);
  root.style.setProperty("--accent-from-rgb", def.fromRgb);
  root.style.setProperty("--accent-to-rgb", def.toRgb);
  root.style.setProperty("--accent-badge-text", def.badgeText);
  root.style.setProperty("--atlas-light-accent", def.lightInk);

  // Sync to native Android widget
  vpnSetAccentTheme(accent);

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("cloakwire:theme-changed", {
        detail: { accent, oled },
      })
    );
  }
}

// Apply on initial script evaluation to prevent flashes
if (typeof window !== "undefined") {
  applyAccentTheme(loadSavedAccent(), loadSavedOled());
}
