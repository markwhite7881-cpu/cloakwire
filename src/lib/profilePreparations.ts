import {api} from "./api";
let generation=0;
export function profilePreparation(){const expected=generation;return()=>{if(expected!==generation)throw Error("profile_check_cancelled")}}
export async function invalidateProfilePreparations(){
 generation++;
 if(typeof window!=="undefined"&&"__TAURI_INTERNALS__" in window)await api.invalidateProfilePreparations();
}
