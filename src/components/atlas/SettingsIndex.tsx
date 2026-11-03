import { useI18n } from "@/lib/i18n";

export function SettingsIndex({sections}:{sections:readonly (readonly [string,string])[]}) {
  const {t}=useI18n();
  return <nav className="atlas-index" aria-label={t("settings.title")}>
    {sections.map(([id,key])=><button key={id} type="button" onClick={()=>{
      const target=document.getElementById(id);
      target?.focus({preventScroll:true});
      target?.scrollIntoView({block:"start"});
    }}>{t(key)}</button>)}
  </nav>;
}
