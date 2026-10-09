import { useCallback, useEffect, useState } from "react";
import {
  type AccentId,
  ACCENTS,
  applyAccentTheme,
  loadSavedAccent,
  loadSavedOled,
} from "@/lib/accentTheme";
import { vpnSetAccentTheme } from "@/lib/vpn";

export function useAccentTheme() {
  const [accent, setAccentState] = useState<AccentId>(loadSavedAccent);
  const [oled, setOledState] = useState<boolean>(loadSavedOled);

  useEffect(() => {
    vpnSetAccentTheme(accent);
  }, [accent]);

  useEffect(() => {
    const handleThemeChange = (e: Event) => {
      const customEvent = e as CustomEvent<{ accent: AccentId; oled: boolean }>;
      if (customEvent.detail) {
        setAccentState(customEvent.detail.accent);
        setOledState(customEvent.detail.oled);
      } else {
        setAccentState(loadSavedAccent());
        setOledState(loadSavedOled());
      }
    };
    window.addEventListener("cloakwire:theme-changed", handleThemeChange);
    window.addEventListener("storage", handleThemeChange);
    return () => {
      window.removeEventListener("cloakwire:theme-changed", handleThemeChange);
      window.removeEventListener("storage", handleThemeChange);
    };
  }, []);

  const setAccent = useCallback((next: AccentId) => {
    setAccentState(next);
    try {
      localStorage.setItem("cloakwire:accent", next);
    } catch {
      // ignore quota
    }
    applyAccentTheme(next, oled);
  }, [oled]);

  const setOled = useCallback((next: boolean) => {
    setOledState(next);
    try {
      localStorage.setItem("cloakwire:oled", next ? "1" : "0");
    } catch {
      // ignore quota
    }
    applyAccentTheme(accent, next);
  }, [accent]);

  return {
    accent,
    setAccent,
    oled,
    setOled,
    accents: ACCENTS,
    currentAccentDef: ACCENTS.find((a) => a.id === accent) || ACCENTS[0],
  };
}
