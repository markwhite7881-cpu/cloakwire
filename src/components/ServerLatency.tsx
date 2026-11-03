import { latencyToBars } from "@/hooks/useServerLatency";
import { cn } from "@/lib/utils";

/** Compact "▮▮▮▮ 47ms" badge. `compact` drops the bars (just the
 *  number) for the small pill at the top of the hero. */
export function ServerLatency({ ms, compact = false }: { ms: number | undefined; compact?: boolean }) {
  if (ms == null) {
    return (
      <span className="text-[10px] text-muted-foreground/60">—</span>
    );
  }
  const bars = latencyToBars(ms);
  return (
    <span className="flex items-center gap-1 text-[10px] tabular-nums text-muted-foreground">
      {!compact && <SignalBars level={bars} />}
      <span>{ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`}</span>
    </span>
  );
}

/** Four little vertical bars, lit up to `level` (0..4). */
function SignalBars({ level }: { level: number }) {
  const heights = [3, 5, 7, 9];
  return (
    <span className="flex items-end gap-[1.5px]" aria-label={`signal ${level} of 4`}>
      {heights.map((h, i) => (
        <span
          key={i}
          className={cn(
            "w-[2px] rounded-sm",
            i < level ? "bg-foreground/70" : "bg-foreground/15",
          )}
          style={{ height: h }}
        />
      ))}
    </span>
  );
}
