import { useEffect, useRef, useState } from "react";
import { Pause, Play, Trash2 } from "lucide-react";
import { Button } from "./Button";
import { cn } from "@/lib/utils";
import type { LogLine } from "@/lib/types";

interface Props {
  logs: LogLine[];
  onClear?: () => void;
  className?: string;
}

function formatTs(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-GB", { hour12: false });
  } catch {
    return "--:--:--";
  }
}

const STREAM_COLOR: Record<LogLine["stream"], string> = {
  stdout: "text-foreground",
  stderr: "text-destructive font-medium",
  system: "text-theme-accent font-medium",
};

import { useI18n } from "@/lib/i18n";

export function LogView({ logs, onClear, className }: Props) {
  const { t } = useI18n();
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState<"all" | "stderr" | "system">("all");
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    if (paused) return;
    if (!stickToBottom.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, paused]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - (el.scrollTop + el.clientHeight);
    stickToBottom.current = distance < 40;
  };

  const visible = filter === "all" ? logs : logs.filter((l) => l.stream === filter);

  return (
    <div className={cn("atlas-console flex flex-col overflow-hidden", className)}>
      <div className="atlas-console-tools">
        <div className="flex items-center gap-1.5">
          {(["all","stderr","system"] as const).map(stream=><button key={stream} type="button"
            className="atlas-filter" aria-pressed={filter===stream} onClick={()=>setFilter(stream)}>
            {t(stream==="all"?"servers.all":stream==="stderr"?"common.error":"common.system")}
          </button>)}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground">
            {visible.length}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setPaused((p) => !p)}
            title={t("logs.autoScroll")}
          >
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          </Button>
          {onClear && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onClear}
              title={t("logs.clear")}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="atlas-log-scroll"
        style={{ minHeight: 0 }}
      >
        {visible.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            {t("logs.emptyLogs")}
          </div>
        ) : (
          visible.map((line, i) => (
            <div key={`${line.ts}-${i}`} className="atlas-log-line">
              <span className="atlas-log-time">
                {formatTs(line.ts)}
              </span>
              <span className={cn("atlas-stream", STREAM_COLOR[line.stream])}>
                {line.stream}
              </span>
              <span className={cn("break-all whitespace-pre-wrap", STREAM_COLOR[line.stream])}>
                {line.line}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
