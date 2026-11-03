import { Eclipse, Monitor, Moon, Sun } from "lucide-react";
import { useAccentTheme } from "@/hooks/useAccentTheme";
import { useThemeMode, THEME_MODES } from "@/lib/themeMode";
import { useI18n } from "@/lib/i18n";
import { AppearanceSelect } from "@/components/atlas/AppearanceSelect";

const icons = { system: Monitor, light: Sun, dark: Moon, oled: Eclipse };

export function AccentThemePicker() {
  const { accent, setAccent, accents } = useAccentTheme();
  const { mode, setMode } = useThemeMode();
  const { t } = useI18n();
  return (
    <>
      <AppearanceSelect label={t("settings.themeMode")} value={mode} onChange={setMode}
        options={THEME_MODES.map(item => {
          const Icon = icons[item.id];
          return { id: item.id, label: t(item.labelKey), icon: <Icon size={16} aria-hidden="true" /> };
        })} />
      <AppearanceSelect label={t("settings.accentColor")} value={accent} onChange={setAccent}
        options={accents.map(item => ({
          id: item.id, label: t("settings.accent" + item.id[0].toUpperCase() + item.id.slice(1)),
          icon: <span className="atlas-color-sample" style={{ backgroundColor: item.colorHex }} aria-hidden="true" />,
        }))} />
    </>
  );
}
