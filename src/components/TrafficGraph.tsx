import { useEffect, useId, useLayoutEffect, useMemo, useRef } from "react";

export type TrafficPoint = { source: object; down: number; up: number };

const WIDTH = 1000;
const BASELINE = 68;
// With a 60-sample buffer, the extra point just off the left edge scrolls into alignment.
const STEP = WIDTH / 58;
const usePaintEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function trace(points: TrafficPoint[], series: "down" | "up", peak: number) {
  let path = "";
  let previousY = BASELINE;
  points.forEach((point, index) => {
    const x = WIDTH - (points.length - 1 - index) * STEP;
    const y = Math.round((BASELINE - (Math.max(0, point[series]) / peak) * 62) * 100) / 100;
    // Both controls stay between measured endpoints, including at sharp spikes.
    const midX = (x - STEP / 2).toFixed(2);
    path += index === 0 ? `M${x.toFixed(2)} ${y}` :
      ` C${midX} ${previousY} ${midX} ${y} ${Math.round(x * 100) / 100} ${y}`;
    previousY = y;
  });
  return path;
}

export function TrafficGraph({ points, label }: { points: TrafficPoint[]; label: string }) {
  const group = useRef<SVGGElement>(null);
  const animation = useRef<Animation | null>(null);
  const visible = useRef(true);
  const previous = useRef<{ source: object; peak: number; at: number }>();
  const gradient = useId();
  const graph = useMemo(() => {
    const peak = Math.max(.1, ...points.map(point => Math.max(point.down, point.up)));
    const down = trace(points, "down", peak);
    const up = trace(points, "up", peak);
    const firstX = WIDTH - (points.length - 1) * STEP;
    const area = down ? `${down} L${WIDTH} ${BASELINE} L${firstX} ${BASELINE}Z` : "";
    return { down, up, peak, area };
  }, [points]);

  usePaintEffect(() => {
    const svg = group.current?.ownerSVGElement;
    if (!svg) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let onScreen = true;
    const syncVisibility = () => {
      visible.current = onScreen && !document.hidden && !motion.matches;
      if (!visible.current) animation.current?.cancel();
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      syncVisibility();
    });
    syncVisibility();
    observer?.observe(svg);
    motion.addEventListener("change", syncVisibility);
    document.addEventListener("visibilitychange", syncVisibility);
    return () => {
      observer?.disconnect();
      motion.removeEventListener("change", syncVisibility);
      document.removeEventListener("visibilitychange", syncVisibility);
      animation.current?.cancel();
      animation.current = null;
    };
  }, []);

  usePaintEffect(() => {
    const node = group.current;
    const last = points.at(-1);
    const before = previous.current;
    const now = performance.now();
    previous.current = last ? { source: last.source, peak: graph.peak, at: now } : undefined;
    // If a faster sample interrupts the transition, preserve the displayed position.
    const displayed = animation.current?.playState === "running" && node
      ? getComputedStyle(node).transform : "none";
    const held = displayed === "none" ? null : new DOMMatrixReadOnly(displayed);
    animation.current?.cancel();
    animation.current = null;
    if (!node?.animate || !visible.current || !before || !last) return;
    const previousIndex = points.findIndex(point => point.source === before.source);
    if (previousIndex < 0 || previousIndex === points.length - 1) return;
    const shift = (points.length - 1 - previousIndex) * STEP + (held?.e ?? 0);
    const scale = graph.peak / before.peak * (held?.d ?? 1);
    const from = `matrix(1,0,0,${scale},${shift},${BASELINE * (1 - scale)})`;
    animation.current = node.animate([{ transform: from }, { transform: "none" }], {
      duration: Math.min(1000, Math.max(80, now - before.at)), easing: "linear",
    });
  }, [points, graph]);

  const single = points.length === 1 ? points[0] : null;
  return (
    <svg viewBox="0 0 1000 72" preserveAspectRatio="none" style={{ overflow: "hidden" }} role="img" aria-label={label}>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox">
          <stop stopColor="var(--accent-badge-text)" stopOpacity=".18"/>
          <stop offset="1" stopColor="var(--accent-badge-text)" stopOpacity=".02"/>
        </linearGradient>
      </defs>
      {[6, 37, BASELINE].map(y => <line key={y} x1="0" x2={WIDTH} y1={y} y2={y} stroke="var(--atlas-line)" />)}
      <g ref={group}>
        <path d={graph.area} fill={`url(#${gradient})`}/>
        <path data-series="down" d={graph.down} fill="none" stroke="var(--accent-badge-text)"
          strokeWidth="2" strokeLinecap="round" vectorEffect="non-scaling-stroke"/>
        <path data-series="up" d={graph.up} fill="none" stroke="currentColor" opacity=".7"
          strokeDasharray="4 3" strokeWidth="1.6" strokeLinecap="round" vectorEffect="non-scaling-stroke"/>
        {single && (["down", "up"] as const).map(series =>
          <circle key={series} cx={WIDTH} cy={BASELINE - 62 * single[series] / graph.peak} r="2.5"
            fill={series === "down" ? "var(--accent-badge-text)" : "currentColor"}/>)}
      </g>
    </svg>
  );
}
