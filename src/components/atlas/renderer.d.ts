export function mountGlobe(scene: HTMLElement, countryName: (country: string) => string): {
  syncProfiles(countries: string[]): void;
  setProfile(country: string | null, running: boolean): void;
  trafficRise(): void;
  destroy(): void;
};
