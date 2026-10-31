import {it,expect} from "vitest";
import fixture from "./fixtures/connection-health.json";
import type {ConnectionHealth} from "./connectionHealth";
import {ProbeResultGate} from "./probeResultGate";
const healthy={...fixture,scope:"selected_profile",outcome:"healthy"} as ConnectionHealth;
const source={profile_ref:healthy.profile_ref,source_revision:healthy.profile_revision};
it("DNS edits reject delayed old success and resubscribed snapshots",()=>{
 const gate=new ProbeResultGate("dns-a");
 expect(gate.accept(healthy,true)).toEqual(healthy);
 expect(gate.inputs("dns-b")).toBe(healthy.operation_id);
 expect(gate.accept(healthy)).toBeNull();
 expect(gate.accept(healthy,true)).toBeNull();
 expect(gate.expect("dns-a",healthy.operation_id)).toBe(false);
 const fresh={...healthy,operation_id:"fresh"};
 expect(gate.expect("dns-b","fresh")).toBe(true);
 expect(gate.accept(fresh)).toEqual(fresh);
 expect(gate.accept(healthy)).toBeNull();
});

it("keeps separate completed measurements when selecting another server",()=>{
 const gate=new ProbeResultGate("server-a");
 gate.expect("server-a",healthy.operation_id);gate.accept(healthy);
 gate.inputs("server-b");
 const second={...healthy,profile_ref:{kind:"manual",id:"b"},profile_revision:"b",operation_id:"second",outcome:"failed"} as ConnectionHealth;
 gate.expect("server-b","second");gate.accept(second);
 gate.inputs("server-a");
 expect(gate.previous(source)).toEqual(healthy);
 expect(gate.results()).toEqual([healthy,second]);
 // Retention is historical only: cancelled work must not resurrect a live result.
 expect(gate.accept(healthy,true)).toBeNull();
});
it("does not cache progress, cancellation, or a late result of an old selection",()=>{
 const gate=new ProbeResultGate("a");gate.expect("a",healthy.operation_id);
 gate.accept({...healthy,outcome:"checking",checked_at:null});
 expect(gate.previous(source)).toBeNull();
 gate.inputs("b");gate.accept(healthy);
 expect(gate.results()).toEqual([]);
});
it("profile edits cannot reuse the previous profile measurement",()=>{
 const gate=new ProbeResultGate("revision-a");gate.expect("revision-a",healthy.operation_id);gate.accept(healthy);
 gate.inputs("revision-b");expect(gate.previous({...source,source_revision:"revision-b"})).toBeNull();
});

it("selection-only settings changes retain the matching result including its reason",()=>{
 const gate=new ProbeResultGate("a/default-null");
 const failure={...healthy,outcome:"failed",issue:"authentication"} as ConnectionHealth;
 gate.expect("a/default-null",failure.operation_id);gate.accept(failure);
 gate.inputs("b/default-b");gate.inputs("a/default-a");
 expect(gate.previous({profile_ref:healthy.profile_ref,source_revision:healthy.profile_revision})).toEqual(failure);
});
