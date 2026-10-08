export type AccentId = "emerald" | "cyan" | "violet" | "amber" | "rose";

export interface AccentDefinition {
  id: AccentId;
  label: string;
  colorHex: string;
  hslValue: string;
  glowRgb: string;
  gradientClass: string;
}

export const ACCENTS: AccentDefinition[] = [
  {
    id: "emerald",
    label: "Emerald",
    colorHex: "#10b981",
    hslValue: "142.1 76.2% 45%",
    glowRgb: "16, 185, 129",
    gradientClass: "from-emerald-500 to-teal-400",
  },
  {
    id: "cyan",
    label: "Cyan",
    colorHex: "#06b6d4",
    hslValue: "189 94% 48%",
    glowRgb: "6, 182, 212",
    gradientClass: "from-cyan-500 to-blue-400",
  },
  {
    id: "violet",
    label: "Violet",
    colorHex: "#8b5cf6",
    hslValue: "262 83% 58%",
    glowRgb: "139, 92, 246",
    gradientClass: "from-violet-500 to-fuchsia-400",
  },
  {
    id: "amber",
    label: "Amber",
    colorHex: "#f59e0b",
    hslValue: "38 92% 50%",
    glowRgb: "245, 158, 11",
    gradientClass: "from-amber-500 to-yellow-400",
  },
  {
    id: "rose",
    label: "Rose",
    colorHex: "#f43f5e",
    hslValue: "349 89% 60%",
    glowRgb: "244, 63, 94",
    gradientClass: "from-rose-500 to-pink-400",
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
  if (oled) {
    root.classList.add("oled");
  } else {
    root.classList.remove("oled");
  }

  const def = ACCENTS.find((a) => a.id === accent) || ACCENTS[0];
  root.style.setProperty("--accent-dynamic-hsl", def.hslValue);
  root.style.setProperty("--accent-glow-rgb", def.glowRgb);
}

// Apply on initial script evaluation to prevent flashes
if (typeof window !== "undefined") {
  applyAccentTheme(loadSavedAccent(), loadSavedOled());
}
