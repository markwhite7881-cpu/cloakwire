import { useCallback, useEffect, useState } from "react";
import {
  type AccentId,
  ACCENTS,
  applyAccentTheme,
  loadSavedAccent,
  loadSavedOled,
} from "@/lib/accentTheme";

export function useAccentTheme() {
  const [accent, setAccentState] = useState<AccentId>(loadSavedAccent);
  const [oled, setOledState] = useState<boolean>(loadSavedOled);

  useEffect(() => {
    applyAccentTheme(accent, oled);
  }, [accent, oled]);

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
