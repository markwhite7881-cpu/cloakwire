import {it,expect} from "vitest";
import {readFileSync} from "node:fs";
it("every frontend Android plugin command is allowed by the packaged capability",()=>{
 const bridge=readFileSync(new URL("./vpn.ts",import.meta.url),"utf8");
 const manifest=readFileSync(new URL("../../src-tauri/permissions/vpn/default.toml",import.meta.url),"utf8");
 const commands=[...bridge.matchAll(/"plugin:vpn\|(\w+)"/g)].map(match=>match[1]);
 expect(commands.length).toBeGreaterThan(3);
 for(const command of commands)expect(manifest,command).toContain('"'+command+'"');
});
