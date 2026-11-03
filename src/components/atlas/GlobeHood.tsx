import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react";

const shell = "M160 8 C127 18 99 40 79 71 C61 95 48 115 35 136 C21 155 13 172 15 191 C18 225 46 252 83 275 C110 292 139 305 160 312 C181 305 210 292 237 275 C274 252 302 225 305 191 C307 172 299 155 285 136 C272 115 259 95 241 71 C221 40 193 18 160 8Z";
const opening = "M160 61 C132 72 98 101 67 124 C58 145 57 165 63 184 C72 215 98 245 125 269 L160 291 L195 269 C222 245 248 215 257 184 C263 165 262 145 253 124 C222 101 188 72 160 61Z";
const crown = "M160 8 C127 18 99 40 79 71 C61 95 48 115 35 136 C24 152 18 165 15 183 C27 160 45 145 67 124 C98 101 132 72 160 61 C188 72 222 101 253 124 C275 145 293 160 305 183 C302 165 296 152 285 136 C272 115 259 95 241 71 C221 40 193 18 160 8Z";
const pleat = "M67 124 C50 142 40 156 39 174 C37 204 62 234 105 262 C78 251 55 240 41 226 C27 212 20 197 23 178 C27 157 47 139 67 124Z";
const hem = "M22 199 C35 229 65 246 96 260 C122 272 144 292 160 306 C135 297 111 285 85 271 C51 251 27 226 22 199Z";

const paintEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function ramp(t: number, start: number, end: number) {
  const p = Math.max(0, Math.min(1, (t - start) / (end - start)));
  return p * p * (3 - 2 * p);
}

// A folded cowl sits below the globe. Its rear rises first; the brow rolls over
// the north edge and the two hems settle last. The same poses run backwards.
export function GlobeHood({ running, children }: { running: boolean; children: ReactNode }) {
  const id = "atlas-hood-" + useId().replace(/:/g, "");
  const frame = useRef<HTMLDivElement>(null);
  const rear = useRef<SVGGElement>(null);
  const front = useRef<SVGGElement>(null);
  const brow = useRef<SVGGElement>(null);
  const folds = useRef<SVGGElement>(null);
  const progress = useRef(running ? 1 : 0);

  paintEffect(() => {
    const root = frame.current!;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const target = running ? 1 : 0;
    let raf = 0;
    function paint(p: number) {
      progress.current = p;
      const rise = ramp(p, 0, .71);
      const drape = ramp(p, .21, .92);
      const finish = ramp(p, .42, 1);
      root.style.setProperty("--hood-orb-scale", String(1 - .23 * ramp(p, .08, .90)));
      root.dataset.hood = p === 0 ? "off" : p === 1 ? "on" : running ? "dressing" : "lifting";
      // Scale about the bottom fold, in SVG coordinates rather than viewport pixels.
      const folded = (open: number, anchor: number, width: number, height: number) => {
        const sx = width + (1 - width) * open, sy = height + (1 - height) * open;
        return `matrix(${sx} 0 0 ${sy} ${160 * (1 - sx)} ${anchor * (1 - sy)})`;
      };
      rear.current!.setAttribute("transform", folded(rise, 254, .76, .15));
      rear.current!.setAttribute("opacity", String(ramp(p, .01, .25)));
      front.current!.setAttribute("transform", folded(drape, 251, .90, .30));
      front.current!.setAttribute("opacity", String(ramp(p, .32, .65)));
      const roll = Math.sin(Math.PI * drape) * (1 - finish);
      brow.current!.setAttribute("transform", `translate(0 ${-8 * roll})`);
      folds.current!.setAttribute("transform", folded(finish, 137, 1.025, .88));
      folds.current!.setAttribute("opacity", String(ramp(p, .42, .78)));
    }
    const start = progress.current;
    const from = performance.now();
    const duration = Math.abs(target - start) * (running ? 960 : 720);
    function step(now: number) {
      const t = Math.min(1, (now - from) / duration);
      paint(t === 1 ? target : start + (target - start) * t);
      if (t < 1) raf = requestAnimationFrame(step);
    }
    function finishIfHidden() {
      if (motion.matches || document.hidden) { cancelAnimationFrame(raf); paint(target); }
    }
    if (!duration || motion.matches || document.hidden) paint(target);
    else { paint(start); raf = requestAnimationFrame(step); }
    motion.addEventListener("change", finishIfHidden);
    document.addEventListener("visibilitychange", finishIfHidden);
    return () => {
      cancelAnimationFrame(raf);
      motion.removeEventListener("change", finishIfHidden);
      document.removeEventListener("visibilitychange", finishIfHidden);
    };
  }, [running]);

  const url = (name: string) => `url(#${id}-${name})`;
  return <div ref={frame} className="atlas-hood-stage">
    <svg className="atlas-hood atlas-hood-rear" viewBox="0 0 320 320" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id+"-lining"} x2=".72" y2="1" gradientUnits="objectBoundingBox">
          <stop stopColor="#516479"/><stop offset=".55" stopColor="#253449"/><stop offset="1" stopColor="#131e2c"/>
        </linearGradient>
      </defs>
      <g ref={rear} opacity="0"><path d={shell} fill={url("lining")}/></g>
    </svg>
    <div className="atlas-hood-orb">{children}</div>
    <svg className="atlas-hood atlas-hood-front" viewBox="0 0 320 320" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id+"-cloth"} x1="0" y1="0" x2=".84" y2="1" gradientUnits="objectBoundingBox">
          <stop stopColor="#b7c8d5"/><stop offset=".38" stopColor="#869bad"/><stop offset=".68" stopColor="#526980"/><stop offset="1" stopColor="#384d63"/>
        </linearGradient>
        <linearGradient id={id+"-brow"} x1=".12" y1="0" x2=".85" y2="1" gradientUnits="objectBoundingBox">
          <stop stopColor="#d1dde5"/><stop offset=".37" stopColor="#afc1ce"/><stop offset=".72" stopColor="#8297ab"/><stop offset="1" stopColor="#657b91"/>
        </linearGradient>
        <linearGradient id={id+"-fold"} x1="0" y1=".6" x2="1" y2=".2" gradientUnits="objectBoundingBox">
          <stop stopColor="#233448"/><stop offset=".63" stopColor="#465c72"/><stop offset="1" stopColor="#7f93a5"/>
        </linearGradient>
        <linearGradient id={id+"-hem"} x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox">
          <stop stopColor="#657d90"/><stop offset=".52" stopColor="#a6b9c8"/><stop offset="1" stopColor="#8398a9"/>
        </linearGradient>
      </defs>
      <g ref={front} opacity="0" strokeLinejoin="round" strokeLinecap="round">
        <path d={shell+" "+opening} fillRule="evenodd" fill={url("cloth")} stroke="#617487" strokeWidth="1"/>
        <g ref={folds}>
          {[false,true].map(right => <g key={String(right)} transform={right ? "translate(320 0) scale(-1 1)" : undefined}>
            <path d={pleat} fill={url("fold")}/>
            <path d={hem} fill={url("hem")}/>
            <path d="M64 129 C52 145 48 160 49 175 C52 204 71 228 94 250" fill="none" stroke="#9db0be" strokeOpacity=".58" strokeWidth="1"/>
          </g>)}
        </g>
        <g ref={brow}>
          <path d={crown} fill={url("brow")}/>
          <path d="M20 173 C34 152 49 141 68 123 C100 98 132 72 160 61 C188 72 220 98 252 123 C271 141 286 152 300 173"
            fill="none" stroke="#25394d" strokeWidth="3" strokeOpacity=".7"/>
          <path d="M25 165 C53 133 79 115 105 93 C126 75 144 65 160 59 C177 65 200 78 218 93 C246 116 273 136 295 162"
            fill="none" stroke="#e5edf2" strokeOpacity=".75" strokeWidth="1.25"/>
          <path d="M151 17 C132 27 116 40 101 59 C119 42 134 31 151 17Z" fill="#eef4f7" opacity=".20"/>
          <path d="M173 19 C196 37 215 61 231 90 C221 72 202 53 187 40Z" fill="#516c83" opacity=".13"/>
          <path d="M159 12 C153 24 153 42 158 54" fill="none" stroke="#edf4f7" strokeOpacity=".65" strokeWidth="1.1"/>
          <path d="M162 12 C158 25 158 42 160 54" fill="none" stroke="#6c8398" strokeOpacity=".4" strokeWidth=".85"/>
        </g>
      </g>
    </svg>
  </div>;
}
