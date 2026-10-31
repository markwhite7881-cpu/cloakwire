import {describe,it,expect} from "vitest";
import {badgeForProfile, sameSource, subscriptionForSource, findSourceIndex, singleAction} from "./profileEvidence";
import type {ProfileSource} from "./profileEvidence";
const a:ProfileSource={profile_ref:{kind:"subscription",subscription_id:"s",link_key:"index-0"},source_revision:"a"};
describe("profile evidence ownership",()=>{
 it("rejects index reuse and other sources",()=>{expect(sameSource(a,{...a,source_revision:"b"})).toBe(false);expect(findSourceIndex([a],{...a,source_revision:"b"})).toBe(-1)});
 it("manual profiles have no subscription action",()=>expect(subscriptionForSource({profile_ref:{kind:"manual",id:"m"},source_revision:"a"})).toBe(null));
 it("only binds a result to the matching source revision",()=>{const evidence={source:a,kind:"preflight" as const,outcome:"passed" as const,checked_at:100};expect(badgeForProfile(a,evidence,120).state).toBe("prepared");expect(badgeForProfile({...a,source_revision:"b"},evidence,120).state).toBe("unknown")});
 it("expired and future results are never green",()=>{const evidence={source:a,kind:"preflight" as const,outcome:"passed" as const,checked_at:100};expect(badgeForProfile(a,evidence,60100).state).toBe("stale");expect(badgeForProfile(a,evidence,99).state).toBe("stale")});
 it("coalesces repeated actions and releases after failure",async()=>{let finish!:()=>void,calls=0;const run=singleAction();const first=run(async()=>{calls++;await new Promise<void>(r=>finish=r)});await run(async()=>{calls++});expect(calls).toBe(1);finish();await first;await expect(run(async()=>{throw Error("fail")})).rejects.toThrow();await run(async()=>{calls++});expect(calls).toBe(2)});
});

it("an isolated successful profile must not claim that the active VPN was verified",()=>{
 const evidence={source:a,kind:"access" as const,scope:"selected_profile" as const,outcome:"passed" as const,checked_at:100};
 expect(badgeForProfile(a,evidence,120).state).toBe("profileHealthy");
});
