import { useEffect, useRef, useState } from "react";

const SESSION_START_KEY = "cloakwire:session_start_time";

export function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;

  const hh = String(h).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");

  return `${hh}:${mm}:${ss}`;
}

export function useSessionTimer(isRunning: boolean) {
  const [seconds, setSeconds] = useState<number>(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isRunning) {
      startRef.current = null;
      setSeconds(0);
      try {
        sessionStorage.removeItem(SESSION_START_KEY);
      } catch {
        // ignore
      }
      return;
    }

    // Restore or initialize start timestamp
    let startTime = startRef.current;
    if (!startTime) {
      try {
        const saved = sessionStorage.getItem(SESSION_START_KEY);
        if (saved) {
          const parsed = parseInt(saved, 10);
          if (!isNaN(parsed) && parsed <= Date.now()) {
            startTime = parsed;
          }
        }
      } catch {
        // ignore
      }
    }

    if (!startTime) {
      startTime = Date.now();
      try {
        sessionStorage.setItem(SESSION_START_KEY, String(startTime));
      } catch {
        // ignore
      }
    }

    startRef.current = startTime;
    setSeconds(Math.max(0, Math.floor((Date.now() - startTime) / 1000)));

    const interval = setInterval(() => {
      if (startRef.current) {
        setSeconds(Math.max(0, Math.floor((Date.now() - startRef.current) / 1000)));
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [isRunning]);

  return {
    seconds,
    formatted: formatDuration(seconds),
  };
}
