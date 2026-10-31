import {it,expect} from "vitest";
import fixture from "./fixtures/connection-health.json";
import type {ConnectionHealth} from "./connectionHealth";
import {ProbeResultGate} from "./probeResultGate";
const healthy={...fixture,scope:"selected_profile",outcome:"healthy"} as ConnectionHealth;
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
