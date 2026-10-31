// Mirrors CloakwireVpnService.configFile(); "xray" is also the owner for sing-box.
export function readAcceptedConfig(readFile) {
  for (const path of ["files/xray-config.json","files/configuration.json"]) {
    try {
      const raw=readFile(path);
      if(raw.length) return {path,raw};
    } catch(e) { if(e.code!=="ENOENT") throw e; }
  }
  throw new Error("accepted_config_missing");
}
const canonical=value=>Array.isArray(value)?value.map(canonical):
  value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
export function sameConfig(a,b) { return JSON.stringify(canonical(JSON.parse(a)))===JSON.stringify(canonical(JSON.parse(b))); }
export function sessionWasDisturbed(before,after,configMatches) {
  return !configMatches || ["state","engine","since","profile_name"].some(k=>before[k]!==after[k]);
}
