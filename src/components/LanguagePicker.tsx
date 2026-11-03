import { useI18n, SUPPORTED_LOCALES } from "@/lib/i18n";
import { AppearanceSelect } from "@/components/atlas/AppearanceSelect";

export function LanguagePicker() {
  const { locale, setLocale, t } = useI18n();
  return <AppearanceSelect label={t("settings.language")} value={locale} onChange={setLocale}
    options={SUPPORTED_LOCALES.map(item => ({ id: item.id, label: item.nativeLabel, lang: item.id }))} />;
}
