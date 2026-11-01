export const SERVER_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Shared across Home remounts; failures and concurrent requests are cached too. */
export class ServerLatencyCache {
 private entries=new Map<string,{at:number;pending:boolean;result:Promise<number|null>}>();
 constructor(private now:()=>number=()=>performance.now()){}
 get(server:string,port:number,probe:()=>Promise<number|null>):Promise<number|null>{
  const key=JSON.stringify([server,port]),existing=this.entries.get(key);
  if(existing&&(existing.pending||this.now()-existing.at<SERVER_CHECK_INTERVAL_MS))return existing.result;
  if(this.entries.size>=1024){for(const [key,value] of this.entries){if(!value.pending){this.entries.delete(key);break;}}}
  const entry={at:this.now(),pending:true,result:Promise.resolve<number|null>(null)};
  entry.result=Promise.resolve().then(probe).catch(()=>null).finally(()=>{entry.pending=false;entry.at=this.now();});
  this.entries.set(key,entry);return entry.result;
 }
}
