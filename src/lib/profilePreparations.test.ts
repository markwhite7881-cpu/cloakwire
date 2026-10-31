import {it,expect} from "vitest";
import {profilePreparation,invalidateProfilePreparations} from "./profilePreparations";
it("a catalog mutation cancels work captured before an asynchronous preparation",async()=>{
 const assertCurrent=profilePreparation();assertCurrent();
 await invalidateProfilePreparations();
 expect(assertCurrent).toThrow("profile_check_cancelled");
 expect(profilePreparation()).not.toThrow();
});
