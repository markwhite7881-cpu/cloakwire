import { Button } from "@/components/Button";
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
  return <section role="alert" className="m-3 space-y-2 rounded-xl border border-amber-500/40 bg-card p-3 text-sm">
    <h2 className="font-semibold">{t("profileStorage.title")}</h2>
    <p>{t(`profileStorage.${state.status}`)}</p>
    {state.status === "legacy_conflict" && <div className="flex flex-wrap gap-2">
      <Button size="lg" variant="outline" onClick={() => choose("current")}>{t("profileStorage.keepCurrent", { count: state.records.length })}</Button>
      {state.legacy && <>
        <Button size="lg" variant="outline" onClick={() => choose("legacy")}>{t("profileStorage.useLegacy", { count: state.legacy.length })}</Button>
        <Button size="lg" variant="outline" onClick={() => choose("merge")}>{t("profileStorage.merge")}</Button>
      </>}
    </div>}
    {state.status === "corrupt" && state.legacy && <Button size="lg" variant="outline" onClick={() => choose("legacy")}>{t("profileStorage.useLegacy", { count: state.legacy.length })}</Button>}
    {["write_failed", "mirror_failed"].includes(state.status) && <Button size="lg" variant="outline" onClick={retry}>{t("profileStorage.retry")}</Button>}
    {failed && <p>{t("profileStorage.write_failed")}</p>}
  </section>;
}
