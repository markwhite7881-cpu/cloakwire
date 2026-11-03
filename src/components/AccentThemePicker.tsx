import { Monitor, Moon, Palette, Sun, Eclipse } from "lucide-react";
import { useAccentTheme } from "@/hooks/useAccentTheme";
import { useThemeMode, THEME_MODES } from "@/lib/themeMode";
import { useI18n } from "@/lib/i18n";

export function AccentThemePicker({ compact = false }: { compact?: boolean }) {
  const { accent, setAccent, accents } = useAccentTheme();
  const { mode, setMode } = useThemeMode();
  const { t } = useI18n();
  const symbols = { system: Monitor, light: Sun, dark: Moon, oled: Eclipse };
  const labels = { emerald: "settings.accentEmerald", cyan: "settings.accentCyan", violet: "settings.accentViolet", amber: "settings.accentAmber", rose: "settings.accentRose" };
  return <div className={compact ? "space-y-3" : "space-y-4"}>
    <div className="space-y-2">
      <h3 className="flex items-center gap-2 text-sm font-medium"><Sun size={16}/>{t("settings.themeMode")}</h3>
      <div className="atlas-options" role="group" aria-label={t("settings.themeMode")}>
        {THEME_MODES.map(item => {const Icon = symbols[item.id];return <button className="atlas-choice" type="button" key={item.id}
          aria-pressed={mode === item.id} onClick={() => setMode(item.id)}><Icon size={15}/>{t(item.labelKey)}</button>;})}
      </div>
    </div>
    <div className="space-y-2">
      <h3 className="flex items-center gap-2 text-sm font-medium"><Palette size={16}/>{t("settings.accentColor")}</h3>
      <div className="atlas-options" role="group" aria-label={t("settings.accentColor")}>
        {accents.map(item => <button className="atlas-choice" type="button" key={item.id} aria-pressed={accent === item.id} onClick={() => setAccent(item.id)}>
          <span aria-hidden="true" className="h-3 w-3 rounded-full" style={{ backgroundColor:item.colorHex }}/>{t(labels[item.id])}
        </button>)}
      </div>
    </div>
  </div>;
}
