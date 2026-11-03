import { useLayoutEffect, useRef } from "react";
import { Link2, Loader2, Trash2, X } from "lucide-react";
import { Button } from "./Button";
import { useI18n } from "@/lib/i18n";
import type { ParseFailure } from "@/lib/types";

interface Props {
  value: string;
  busy: boolean;
  failures: ParseFailure[];
  error: string | null;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

export function ServerImportDialog({ value, busy, failures, error, onChange, onSubmit, onClose }: Props) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const node = dialog.current!;
    node.showModal();
    input.current?.focus();
    return () => node.close();
  }, []);

  return <dialog ref={dialog} aria-labelledby="server-import-title" className="atlas-dialog atlas-import-dialog atlas-server-dialog"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={event => {
      if (busy || event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    <div className="atlas-import-heading">
      <Link2 size={20} aria-hidden="true" />
      <h2 id="server-import-title">{t("atlas.importSources")}</h2>
      <Button type="button" size="icon" variant="ghost" aria-label={t("common.close")} disabled={busy} onClick={onClose}><X size={16} /></Button>
    </div>
    <textarea ref={input} value={value} aria-label={t("atlas.importSources")} readOnly={busy} spellCheck={false}
      onChange={event => onChange(event.target.value)}
      placeholder={"vless://…\nhttps://provider.example.com/sub?token=…"}
      className="atlas-input w-full resize-y font-mono" />
    {(error || failures.length > 0) && <div role="alert" className="atlas-import-errors">
      {error && <p>{error}</p>}
      {failures.length > 0 && <><p>{t("servers.parseErrorsCount", { count: failures.length })}</p>
        <ul>{failures.map((f, i) => <li key={i}>{f.error.message}</li>)}</ul></>}
    </div>}
    <div className="atlas-import-actions">
      <Button type="button" size="icon" variant="ghost" aria-label={t("servers.clearInput")} disabled={busy || !value} onClick={() => onChange("")}><Trash2 size={16} /></Button>
      <Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
      <Button type="button" disabled={busy || !value.trim()} onClick={onSubmit}>{busy && <Loader2 size={15} className="animate-spin" />}{t("servers.addServer")}</Button>
    </div>
  </dialog>;
}
