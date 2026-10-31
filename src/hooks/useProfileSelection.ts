import { useCallback, useState } from "react";
import { retainedSelectionIndex, selectProfileKey } from "@/lib/profileSelection";
export function useProfileSelection(keys: readonly (string | null)[], initialIndex = -1): [number, (index: number) => void] {
  const [selection, setSelection] = useState(() => selectProfileKey(initialIndex, keys));
  const select = useCallback((index: number) => setSelection(selectProfileKey(index, keys)), [keys]);
  return [retainedSelectionIndex(selection, keys), select];
}
