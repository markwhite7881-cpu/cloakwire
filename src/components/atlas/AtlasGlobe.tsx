import { useEffect, useRef } from "react";
import { useI18n } from "@/lib/i18n";
import { GlobeHood } from "./GlobeHood";
import { mountGlobe } from "./renderer";

interface GlobeProps {
  countries: string;
  country: string | null;
  running: boolean;
  bytesPerSecond: number;
}

export function AtlasGlobe({ countries, country, running, bytesPerSecond }: GlobeProps) {
  const { locale, t } = useI18n();
  const scene = useRef<HTMLDivElement>(null);
  const globe = useRef<ReturnType<typeof mountGlobe>>();
  const lastRate = useRef(0);
  useEffect(() => {
    if (!scene.current) return;
    const names = new Intl.DisplayNames([locale], { type: "region" });
    const view = mountGlobe(scene.current, code => names.of(code) ?? code);
    globe.current = view;
    return () => { view.destroy(); globe.current = undefined; };
  }, [locale]);
  useEffect(() => {
    const visible = new Set(countries.split(" ").filter(Boolean));
    if (country) visible.add(country);
    globe.current?.syncProfiles([...visible]);
    globe.current?.setProfile(country, running);
  }, [country, countries, running, locale]);
  useEffect(() => {
    if (running && lastRate.current > 0 && bytesPerSecond - lastRate.current > Math.max(65536, lastRate.current * 0.35))
      globe.current?.trafficRise();
    lastRate.current = running ? bytesPerSecond : 0;
  }, [bytesPerSecond, running, country]);
  return <div className="atlas-scene" ref={scene} data-running={running}>
    <GlobeHood running={running}>
      <canvas role="img" aria-label={t("atlas.globe")} />
      <svg className="ah-globe-fx" aria-hidden="true">
        <defs>
          <clipPath id="cw-sphere-clip"><circle /></clipPath>
          <radialGradient id="cw-light"><stop offset="0" stopColor="#eff5ff" stopOpacity=".35"/><stop offset="1" stopColor="#eff5ff" stopOpacity="0"/></radialGradient>
        </defs>
        <g clipPath="url(#cw-sphere-clip)">
          <ellipse className="ah-light-sweep" fill="url(#cw-light)" />
          <g className="ah-country-lines" fill="none" strokeLinejoin="round" strokeLinecap="round">
            <path className="ah-line-edge"/><path className="ah-line-pulse"/><path className="ah-line-wave" pathLength="1"/>
          </g>
        </g>
      </svg>
      <span className="ah-label" aria-hidden="true" />
    </GlobeHood>
  </div>;
}
