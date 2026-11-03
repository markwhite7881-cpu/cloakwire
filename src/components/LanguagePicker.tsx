import { Globe } from "lucide-react";
import { useI18n, SUPPORTED_LOCALES } from "@/lib/i18n";

export function LanguagePicker() {
  const { locale, setLocale, t } = useI18n();
  return <div className="space-y-3">
    <h3 className="flex items-center gap-2 text-sm font-medium"><Globe size={16}/>{t("settings.language")}</h3>
    <div className="atlas-options" role="group" aria-label={t("settings.language")}>
      {SUPPORTED_LOCALES.map(item => <button type="button" key={item.id} lang={item.id}
        aria-pressed={locale === item.id} onClick={() => setLocale(item.id)}>{item.nativeLabel}</button>)}
    </div>
  </div>;
}
