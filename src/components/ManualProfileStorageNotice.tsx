import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { LoadResult } from "@/lib/manualProfileStore";

export function ManualProfileStorageNotice({ state, retry, reconcile }: {
  state: LoadResult; retry: () => void; reconcile: (choice: "current" | "legacy" | "merge") => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  if (state.status === "ready") return null;
  const choose = async(choice: "current" | "legacy" | "merge") => setFailed(!await reconcile(choice));
  const button = "min-h-11 rounded-lg border border-border px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary";
  return <section role="alert" className="m-3 space-y-2 rounded-xl border border-amber-500/40 bg-card p-3 text-sm">
    <h2 className="font-semibold">{t("profileStorage.title")}</h2>
    <p>{t(`profileStorage.${state.status}`)}</p>
    {state.status === "legacy_conflict" && <div className="flex flex-wrap gap-2">
      <button className={button} onClick={() => choose("current")}>{t("profileStorage.keepCurrent", { count: state.records.length })}</button>
      {state.legacy && <>
        <button className={button} onClick={() => choose("legacy")}>{t("profileStorage.useLegacy", { count: state.legacy.length })}</button>
        <button className={button} onClick={() => choose("merge")}>{t("profileStorage.merge")}</button>
      </>}
    </div>}
    {state.status === "corrupt" && state.legacy && <button className={button} onClick={() => choose("legacy")}>{t("profileStorage.useLegacy", { count: state.legacy.length })}</button>}
    {["write_failed", "mirror_failed"].includes(state.status) && <button className={button} onClick={retry}>{t("profileStorage.retry")}</button>}
    {failed && <p>{t("profileStorage.write_failed")}</p>}
  </section>;
}
