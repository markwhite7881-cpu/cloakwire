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

// All device operations explicitly target Android user 0.
export function userAppPid(processes,app) {
  const rows=processes.split("\n").map(line=>line.trim().split(/\s+/))
    .filter(([pid,user,name])=>/^\d+$/.test(pid) && /^u0_a\d+$/.test(user) && name===app);
  if(rows.length!==1) throw new Error("webview_unavailable");
  return rows[0][0];
}
