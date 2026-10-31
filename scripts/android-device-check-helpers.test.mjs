import test from "node:test";
import assert from "node:assert/strict";
import {readAcceptedConfig, sameConfig, sessionWasDisturbed} from "./android-device-check-helpers.mjs";

const read = files => path => {
  if (Object.hasOwn(files,path)) return files[path];
  throw Object.assign(new Error("missing"),{code:"ENOENT"});
};
test("sing-box snapshot uses the service's preferred nonempty xray filename",()=>{
  const files={"files/xray-config.json":'{"engine":"current"}',"files/configuration.json":'{"engine":"stale"}'};
  assert.deepEqual(readAcceptedConfig(read(files)),{path:"files/xray-config.json",raw:files["files/xray-config.json"]});
});
test("missing or empty preferred file falls back, but access errors do not",()=>{
  assert.equal(readAcceptedConfig(read({"files/configuration.json":"{}"})).path,"files/configuration.json");
  assert.equal(readAcceptedConfig(read({"files/xray-config.json":"","files/configuration.json":"{}"})).path,"files/configuration.json");
  assert.throws(()=>readAcceptedConfig(()=>{throw Object.assign(new Error("denied"),{code:"EACCES"})}),/denied/);
});
test("restoration checks full config rather than only TUN package lists",()=>{
  const a='{"outbounds":[{"uuid":"original"}],"inbounds":[{"exclude_package":["app.a"]}]}';
  const b='{"inbounds":[{"exclude_package":["app.a"]}],"outbounds":[{"uuid":"replacement"}]}';
  assert.equal(sameConfig(a,b),false);
  assert.equal(sameConfig(a,JSON.stringify(JSON.parse(a),null,2)),true);
  assert.equal(sameConfig('{"a":1,"b":2}','{"b":2,"a":1}'),true);
  assert.equal(sameConfig('{"rules":[1,2]}','{"rules":[2,1]}'),false);
});
test("negative start regressions require recovery before any explicit routing mutation",()=>{
  const original={state:"running",engine:"sing-box",since:1,profile_name:"fixture"};
  assert.equal(sessionWasDisturbed(original,{...original,state:"stopped"},true),true);
  assert.equal(sessionWasDisturbed(original,{...original,since:2},true),true);
  assert.equal(sessionWasDisturbed(original,original,false),true);
  assert.equal(sessionWasDisturbed(original,original,true),false);
});
