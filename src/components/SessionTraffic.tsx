import { createContext, useContext, type ReactNode } from "react";
import { useTrafficStream, type UseTrafficStream } from "@/hooks/useTrafficStream";

const TrafficContext = createContext<UseTrafficStream>({ samples: [], current: null });
const preview = typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);

export function SessionTraffic({ running, runId, children }: {
  running: boolean;
  runId?: string | null;
  children: ReactNode;
}) {
  const traffic = useTrafficStream(running || preview, runId);
  return <TrafficContext.Provider value={traffic}>{children}</TrafficContext.Provider>;
}

export function useSessionTraffic() {
  return useContext(TrafficContext);
}
