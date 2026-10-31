import {sameSource,type ProfileSource} from "./profileEvidence";
import type {ConnectionHealth} from "./connectionHealth";
/** An input edit permanently retires previous IDs, even across listener resubscription. */
export class ProbeResultGate {
 private key:string;
 private id:string|null=null;
 private restoreAllowed=true;
 private readonly completed=new Map<string,ConnectionHealth>();
 private readonly retired=new Set<string>();
 constructor(key:string){this.key=key}
 inputs(key:string):string|null {
  if(key===this.key)return null;
  const previous=this.id;if(previous)this.retired.add(previous);
  this.key=key;this.id=null;this.restoreAllowed=false;return previous;
 }
 expect(key:string,id:string):boolean {
  if(key!==this.key||this.retired.has(id)){this.retired.add(id);return false}
  if(this.id&&this.id!==id)this.retired.add(this.id);
  this.id=id;this.restoreAllowed=false;return true;
 }
 previous(source:ProfileSource|null):ConnectionHealth|null {
  return this.results().reverse().find(value=>sameSource(source,{profile_ref:value.profile_ref,source_revision:value.profile_revision}))??null;
 }
 results():ConnectionHealth[] {return [...this.completed.values()]}
 private remember(value:ConnectionHealth):ConnectionHealth {
  if(value.scope==="selected_profile"&&["healthy","failed","unavailable"].includes(value.outcome)&&value.checked_at&&Number.isFinite(Date.parse(value.checked_at))){
   this.completed.delete(this.key);this.completed.set(this.key,value);
   if(this.completed.size>100)this.completed.delete(this.completed.keys().next().value!);
  }
  return value;
 }
 accept(value:ConnectionHealth|null,restore=false):ConnectionHealth|null {
  if(!value)return null;
  if(this.retired.has(value.operation_id))return null;
  if(value.operation_id===this.id)return this.remember(value);
  if(restore&&this.restoreAllowed){this.id=value.operation_id;this.restoreAllowed=false;return this.remember(value)}
  return null;
 }
}
