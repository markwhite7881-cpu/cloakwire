/** Local random record identity, never server credentials or a credential hash. */
export function manualProfileHint(id:string,peers:readonly string[]):string{
  let length=Math.min(8,id.length);
  while(length<id.length&&peers.some(other=>other!==id&&other.startsWith(id.slice(0,length))))length++;
  return "#"+id.slice(0,length);
}
