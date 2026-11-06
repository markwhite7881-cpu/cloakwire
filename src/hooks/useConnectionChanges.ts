import {useCallback, useRef, useState} from "react";

/** A successful connection applies its own settings, never edits made later. */
export function useConnectionChanges() {
  const revision = useRef(0);
  const [desired, setDesired] = useState(0);
  const [applied, setApplied] = useState(0);
  const markChanged = useCallback(() => { setDesired(++revision.current); }, []);
  const capture = useCallback(() => revision.current, []);
  const acknowledge = useCallback((accepted: number) => { setApplied(accepted); }, []);
  return {pending: desired !== applied, markChanged, capture, acknowledge};
}
