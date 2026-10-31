import {it,expect} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {ProfileHealthBadge,ProfileHealthContext} from "./ProfileHealthBadge";
it("does not fill untested server rows with diagnostic notices",()=>{
 const source={profile_ref:{kind:"manual" as const,id:"a"},source_revision:"r"};
 const html=renderToStaticMarkup(<ProfileHealthContext.Provider value={{sources:[source],evidence:null}}><ProfileHealthBadge profileRef={source.profile_ref}/></ProfileHealthContext.Provider>);
 expect(html).toBe("");
});

it("an access-only card never shows the connection preflight as a server check",()=>{
 const source={profile_ref:{kind:"manual" as const,id:"a"},source_revision:"r"};
 for(const outcome of ["passed","failed"] as const){
 const html=renderToStaticMarkup(<ProfileHealthContext.Provider value={{sources:[source],evidence:{source,kind:"preflight",outcome,checked_at:Date.now()}}}><ProfileHealthBadge profileRef={source.profile_ref} accessOnly/></ProfileHealthContext.Provider>);
 expect(html).toBe("");
 }
});
