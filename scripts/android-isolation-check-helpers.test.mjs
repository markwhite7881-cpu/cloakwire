import test from "node:test";
import assert from "node:assert/strict";
import {observeTraffic, sameActiveDiagnostic} from "./android-isolation-check-helpers.mjs";

const success = {defaultIsVpn:true, https204:true, networkUnchanged:true};
const fixture = overrides => {
  let time = 0;
  return {start:async()=>{}, read:async()=>success, isActive:async()=>true,
    wait:async ms=>{time += ms}, now:()=>time, timeoutMs:300, ...overrides};
};

test("ordinary HTTPS cannot count as concurrent after diagnostics dies during the request", async()=>{
  let alive = true;
  const actual = await observeTraffic(fixture({
    isActive:async()=>alive,
    read:async()=>{alive=false; return success;}
  }));
  assert.deepEqual(actual,{failure:"diagnostic_not_active"});
});

test("an expired diagnostic refuses to start the ordinary request", async()=>{
  let started = false;
  const actual = await observeTraffic(fixture({isActive:async()=>false, start:async()=>{started=true}}));
  assert.deepEqual(actual,{failure:"diagnostic_not_active"});
  assert.equal(started,false);
});

test("lost or unreadable diagnostic between polls fails closed", async()=>{
  let polls = 0;
  const actual = await observeTraffic(fixture({
    read:async()=>{polls++; throw Error("not ready")},
    isActive:async()=>{if(polls)throw Error("process unreadable"); return true;}
  }));
  assert.deepEqual(actual,{failure:"diagnostic_not_active"});
});

test("live diagnostics can coexist with delayed ordinary traffic", async()=>{
  let polls = 0, checks = 0;
  const actual = await observeTraffic(fixture({
    read:async()=>++polls===1 ? null : success,
    isActive:async()=>{checks++; return true;}
  }));
  assert.deepEqual(actual,{result:success});
  assert.ok(checks >= 5);
});

test("missing ordinary result times out even while diagnostics stays alive", async()=>{
  assert.deepEqual(await observeTraffic(fixture({read:async()=>null})),{failure:"traffic_timeout"});
});

test("only the same live PID and nonterminal result establish diagnostic liveness",()=>{
  const ready={state:"ready",pid:42};
  assert.equal(sameActiveDiagnostic(42,"42",ready),true);
  for(const [pid,result] of [[null,ready],["43",ready],["42",{...ready,state:"cancelled"}],["42",{...ready,pid:43}],["42",null]]){
    assert.equal(sameActiveDiagnostic(42,pid,result),false);
  }
  assert.equal(sameActiveDiagnostic(0,"0",{state:"ready",pid:0}),false);
});
