export function isValidProfileSelection(index: number, profileCount: number): boolean {
  return index === -1 || (index >= 0 && index < profileCount);
}

export interface ProfileSelection { key: string | null; index: number }
export function selectProfileKey(index: number, keys: readonly (string | null)[]): ProfileSelection {
  return { key: index >= 0 ? keys[index] ?? null : null, index };
}
export function retainedSelectionIndex(selection: ProfileSelection, keys: readonly (string | null)[]): number {
  return selection.key !== null ? keys.indexOf(selection.key) :
    isValidProfileSelection(selection.index, keys.length) ? selection.index : -1;
}

export function isMissingProfileSelection(selection:ProfileSelection,keys:readonly(string|null)[]):boolean{
  return selection.key!==null?!keys.includes(selection.key):selection.index>=0&&!isValidProfileSelection(selection.index,keys.length);
}
