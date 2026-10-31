import type {ConnectionHealth} from "./connectionHealth";
/** An input edit permanently retires previous IDs, even across listener resubscription. */
export class ProbeResultGate {
 private key:string;
 private id:string|null=null;
 private restoreAllowed=true;
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
 accept(value:ConnectionHealth|null,restore=false):ConnectionHealth|null {
  if(!value)return null;
  if(this.retired.has(value.operation_id))return null;
  if(value.operation_id===this.id)return value;
  if(restore&&this.restoreAllowed){this.id=value.operation_id;this.restoreAllowed=false;return value}
  return null;
 }
}
