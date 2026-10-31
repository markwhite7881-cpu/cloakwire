import { useCallback, useRef, useState } from "react";
import { isMissingProfileSelection, retainedSelectionIndex, selectProfileKey } from "@/lib/profileSelection";
export function useProfileSelection(keys: readonly (string | null)[], initialIndex = -1): [number, (index: number) => void, boolean, () => boolean] {
  const [selection, setSelection] = useState(() => selectProfileKey(initialIndex, keys));
  const live=useRef({selection,keys});live.current={selection,keys};
  const select=useCallback((index:number)=>{
    const next=selectProfileKey(index,live.current.keys);live.current.selection=next;setSelection(next);
  },[]);
  const requiresChoice=useCallback(()=>isMissingProfileSelection(live.current.selection,live.current.keys),[]);
  return [retainedSelectionIndex(selection,keys),select,isMissingProfileSelection(selection,keys),requiresChoice];
}
