import { Clock, Loader2, Power } from "lucide-react";
import { Button } from "@/components/Button";
import { useI18n } from "@/lib/i18n";

interface Props {
  headline: string;
  running: boolean;
  transition: boolean;
  disabled: boolean;
  duration?: string | null;
  onToggle: () => void;
}

export function ConnectionControl({ headline, running, transition, disabled, duration, onToggle }: Props) {
  const { t } = useI18n();
  return (
    <div className="atlas-connection-controls">
      <div className="atlas-session-line">
        <h1>{headline}</h1>
        {running && duration && <span className="atlas-session-time" title={t("home.sessionTime")}>
          <Clock size={13} aria-hidden="true" />{duration}
        </span>}
      </div>
      <Button type="button" className="atlas-power" data-running={running} disabled={disabled} onClick={onToggle}>
        {transition ? <Loader2 size={17} aria-hidden="true" className="animate-spin" /> : <Power size={17} aria-hidden="true" />}
        {t(running ? "common.disconnect" : "common.connect")}
      </Button>
    </div>
  );
}
