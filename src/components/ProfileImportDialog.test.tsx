import { describe,it,expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProfileImportContent } from "./ProfileImportDialog";
import { planProfileImport } from "@/lib/profileImport";
import { newManualRecord } from "@/lib/manualProfileStore";
import type { Outbound } from "@/lib/types";
describe("import comparison privacy",()=>{
  it("shows categories and explicit choices without secret values",()=>{
    const outbound:Outbound={protocol:"vless",tag:"My server",server:"fixture.invalid",port:443,uuid:"OLD_SECRET",transport:{kind:"tcp"},tls:{enabled:true,alpn:[],allow_insecure:false}};
    const records=[newManualRecord(outbound)],plan=planProfileImport(records,[{...outbound,uuid:"NEW_SECRET"}]);
    const html=renderToStaticMarkup(<ProfileImportContent plan={plan} records={records} decisions={{}} onDecision={()=>{}} />);
    expect(html).toContain("User credentials");expect(html).toContain("My server");
    expect(html).toContain("Add separately");expect(html).toContain("Update");
    expect(html).not.toContain("OLD_SECRET");expect(html).not.toContain("NEW_SECRET");
  });
});
