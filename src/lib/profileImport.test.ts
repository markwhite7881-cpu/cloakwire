import { describe, expect, it } from "vitest";
import { applyProfileImport, planProfileImport } from "./profileImport";
import { newManualRecord, replaceManualRecord } from "./manualProfileStore";
import type { Outbound } from "./types";
const node = (uuid="old", tag="My server", server="fixture.invalid"): Outbound => ({
  protocol:"vless", tag, server, port:443, uuid, transport:{kind:"tcp"},
  tls:{enabled:true,alpn:[],allow_insecure:false,reality:{public_key:"fixture-key",short_id:"ab"}}
});
describe("manual profile import decisions",()=>{
  it("same endpoint with different credentials requires explicit choice and never exposes values",()=>{
    const existing=[newManualRecord(node())]; const plan=planProfileImport(existing,[node("SECRET_SENTINEL")]);
    expect(plan.items[0].candidates[0].changed_fields).toEqual(["user"]);
    expect(JSON.stringify(plan.items[0].candidates)).not.toContain("SECRET_SENTINEL");
    expect(applyProfileImport(plan,{},existing)).toEqual({status:"needs_choice"});
  });
  it("skips exact duplicate including a renamed link without changing records",()=>{
    const existing=[newManualRecord(node())]; const plan=planProfileImport(existing,[node("old","New label")]);
    expect(plan.items[0].candidates[0].exact_duplicate).toBe(true);
    const result=applyProfileImport(plan,{},existing);
    expect(result).toMatchObject({status:"applied",records:existing,changedIds:[]});
  });
  it("multiple candidates never choose which account to replace",()=>{
    const existing=[newManualRecord(node()),newManualRecord(node("other"))];
    expect(planProfileImport(existing,[node("new")]).items[0].candidates).toHaveLength(2);
    expect(applyProfileImport(planProfileImport(existing,[node("new")]),{},existing).status).toBe("needs_choice");
  });
  it("update keeps id, custom name, position and frozen active snapshot; bumps revision",()=>{
    const existing=[newManualRecord(node("other","First")),newManualRecord(node())];
    const active=structuredClone(existing[1]); const plan=planProfileImport(existing,[node("new","Provider name")]);
    const result=applyProfileImport(plan,{0:{kind:"update",record_id:active.id,expected_revision:1}},existing);
    expect(result.status).toBe("applied"); if(result.status!=="applied")return;
    expect(result.records[0]).toEqual(existing[0]);
    expect(result.records[1]).toMatchObject({id:active.id,revision:2,outbound:{tag:"My server",uuid:"new"}});
    expect(active.outbound).toEqual(node()); expect(existing[1]).toEqual(active);
  });
  it("rejects stale revision/deletion and a forged choice atomically",()=>{
    const existing=[newManualRecord(node())]; const id=existing[0].id;
    const plan=planProfileImport(existing,[node("new")]); const decisions={0:{kind:"update" as const,record_id:id,expected_revision:1}};
    expect(applyProfileImport(plan,decisions,[replaceManualRecord(existing[0],node("newer"))]).status).toBe("stale");
    expect(applyProfileImport(plan,decisions,[]).status).toBe("stale");
    expect(applyProfileImport(plan,{0:{...decisions[0],record_id:"subscription-entry"}},existing).status).toBe("stale");
  });
  it("add separately creates a distinct id and collision-free tag without changing existing rules targets",()=>{
    const existing=[newManualRecord(node("old","Same")),newManualRecord(node("other","Same (2)"))];
    const result=applyProfileImport(planProfileImport(existing,[node("new","Same")]),{0:{kind:"add_separately"}},existing);
    expect(result.status).toBe("applied"); if(result.status!=="applied")return;
    expect(result.records.slice(0,2)).toEqual(existing);
    expect(result.records[2].outbound).toMatchObject({tag:"Same (3)",uuid:"new"});
    expect(existing.some(r=>r.id===result.records[2].id)).toBe(false);
  });
  it("skips duplicate input rows and cancellation choices without losing unrelated additions",()=>{
    const existing=[newManualRecord(node())];
    const result=applyProfileImport(planProfileImport(existing,[node("new"),node("second","Second","other.invalid"),node("second","Second","other.invalid")]),{0:{kind:"skip"}},existing);
    expect(result.status).toBe("applied"); if(result.status!=="applied")return;
    expect(result.records).toHaveLength(2); expect(result.records[0]).toEqual(existing[0]);
  });
  it("rejects two different updates to the same record in a batch",()=>{
    const existing=[newManualRecord(node())], id=existing[0].id;
    const choice={kind:"update" as const,record_id:id,expected_revision:1};
    expect(applyProfileImport(planProfileImport(existing,[node("new"),node("different")]),{0:choice,1:choice},existing).status).toBe("conflict");
  });
});
