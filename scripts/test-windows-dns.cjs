// Isolated sing-box experiment. All listeners and destinations are loopback.
// No TUN, system proxy, OS DNS, routes, firewall, or installed app settings are used.
const net = require('node:net');
const dgram = require('node:dgram');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {once} = require('node:events');
const assert = require('node:assert/strict');

// Usage: node scripts/test-windows-dns.cjs CORE CONFIG direct|proxy OUTPUT_DIR
// CONFIG is emitted by the actual Rust config generator or ready-profile merge.
// Raw UDP queries belong to this node.exe process. Shared Windows DNS Client
// attribution needs separate on-device testing; it cannot identify the caller.
const [bin, inputPath, expected, dir] = process.argv.slice(2);
assert.ok(bin && inputPath && ['direct','proxy'].includes(expected) && dir, 'CORE CONFIG direct|proxy OUTPUT_DIR required');
fs.mkdirSync(dir,{recursive:true});
const observations = [];
const flags=process.argv.slice(6);
const localQueries=[];
function questionName(msg){let i=12;const labels=[];while(msg[i]){labels.push(msg.subarray(i+1,i+1+msg[i]).toString());i+=msg[i]+1;}return labels.join('.');}
const sharedOwner=flags.includes('shared-owner');
const hostnameProxy=flags.includes('bootstrap-hostname');
const crossCache=flags.includes('cache-separation');
const sockets = new Set();
const servers = [];
let proxyAvailable = false;
let child;
let coreLog = '';
const counters = {localUdp:0, remoteTcp:0, proxyConnect:0, proxyRejected:0, http:0};
const record = (name, data) => { const row={name,...data,counters:{...counters}};observations.push(row);console.log(JSON.stringify(row)); };
const track = socket => {sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});return socket;};
async function listen(server) {servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;}
async function freePort() {const s=net.createServer();await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));const p=s.address().port;await new Promise(resolve=>s.close(resolve));return p;}
function dnsQuestion(name,type=1,id=1234) {
  const header=Buffer.alloc(12);header.writeUInt16BE(id,0);header.writeUInt16BE(0x0100,2);header.writeUInt16BE(1,4);
  const labels=name.split('.').flatMap(label=>[Buffer.from([label.length]),Buffer.from(label)]);
  const tail=Buffer.alloc(5);tail[0]=0;tail.writeUInt16BE(type,1);tail.writeUInt16BE(1,3);
  return Buffer.concat([header,...labels,tail]);
}
function dnsAnswer(question) {
  let end=12;while(question[end])end+=1+question[end];end+=5;
  const type=question.readUInt16BE(end-4);const header=Buffer.from(question.subarray(0,12));header.writeUInt16BE(0x8180,2);header.writeUInt16BE(type===1?1:0,6);
  if(type!==1)return Buffer.concat([header,question.subarray(12,end)]);
  const rr=Buffer.from([0xc0,0x0c,0,1,0,1,0,0,0,60,0,4,127,0,0,1]);
  return Buffer.concat([header,question.subarray(12,end),rr]);
}
async function dnsQuery(port,name,type=1) {
  const socket=dgram.createSocket('udp4');const start=Date.now();
  return new Promise(resolve=>{
    const timer=setTimeout(()=>{socket.close();resolve({elapsedMs:Date.now()-start,error:'timeout'});},1500);
    socket.once('message',msg=>{clearTimeout(timer);socket.close();resolve({elapsedMs:Date.now()-start,rcode:msg.readUInt16BE(2)&15,answers:msg.readUInt16BE(6),hex:msg.toString('hex')});});
    socket.send(dnsQuestion(name,type),port,'127.0.0.1');
  });
}
async function otherOwnerDns(port,name) {
  const payload=dnsQuestion(name).toString('base64');
  const script="$client=New-Object System.Net.Sockets.UdpClient; $client.Client.ReceiveTimeout=1500; $client.Connect('127.0.0.1',"+port+"); $data=[Convert]::FromBase64String('"+payload+"'); [void]$client.Send($data,$data.Length); $peer=New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any,0); $response=$client.Receive([ref]$peer); $client.Dispose(); [Console]::Write([Convert]::ToBase64String($response))";
  const worker=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';worker.stdout.on('data',c=>stdout+=c);worker.stderr.on('data',c=>stderr+=c);
  const [code]=await once(worker,'close');assert.equal(code,0,stderr);return Buffer.from(stdout.trim(),'base64');
}
async function proxyHttp(port,target) {
  const start=Date.now();return new Promise(resolve=>{
    const request=http.get({hostname:'127.0.0.1',port,path:target,headers:{Host:new URL(target).host},timeout:2500},response=>{
      let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>resolve({elapsedMs:Date.now()-start,status:response.statusCode,body}));
    });request.on('error',e=>resolve({elapsedMs:Date.now()-start,error:e.message}));request.on('timeout',()=>request.destroy(new Error('timeout')));
  });
}
function bufferReader(socket,onFrame) {let buffer=Buffer.alloc(0);socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);let used;while((used=onFrame(buffer))>0)buffer=buffer.subarray(used);});}
async function main() {
  const local=dgram.createSocket('udp4');servers.push(local);local.on('message',(msg,rinfo)=>{counters.localUdp++;localQueries.push(questionName(msg));local.send(dnsAnswer(msg),rinfo.port,rinfo.address);});local.bind(0,'127.0.0.1');await once(local,'listening');const localPort=local.address().port;
  const remote=net.createServer(socket=>{track(socket);bufferReader(socket,buffer=>{if(buffer.length<2)return 0;const length=buffer.readUInt16BE();if(buffer.length<length+2)return 0;counters.remoteTcp++;const response=dnsAnswer(buffer.subarray(2,length+2));const size=Buffer.alloc(2);size.writeUInt16BE(response.length);socket.write(Buffer.concat([size,response]));return length+2;});});
  const remotePort=await listen(remote);
  const socks=net.createServer(socket=>{track(socket);let stage=0;bufferReader(socket,buffer=>{
    if(stage===0){if(buffer.length<2||buffer.length<2+buffer[1])return 0;stage=1;socket.write(Buffer.from([5,0]));return 2+buffer[1];}
    if(stage!==1||buffer.length<4)return 0;
    let needed,host,port;
    if(buffer[3]===1){needed=10;if(buffer.length<needed)return 0;host=[...buffer.subarray(4,8)].join('.');port=buffer.readUInt16BE(8);}
    else if(buffer[3]===3){needed=7+buffer[4];if(buffer.length<needed)return 0;host=buffer.subarray(5,5+buffer[4]).toString();port=buffer.readUInt16BE(5+buffer[4]);}
    else {socket.destroy();return buffer.length;}
    counters.proxyConnect++;stage=2;
    if(!proxyAvailable){counters.proxyRejected++;socket.end(Buffer.from([5,1,0,1,127,0,0,1,0,0]));return needed;}
    assert.equal(host,'127.0.0.1');assert.equal(port,remotePort);
    const upstream=track(net.connect({host,port}));upstream.once('connect',()=>{socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));socket.pipe(upstream);upstream.pipe(socket);});upstream.on('error',()=>socket.destroy());socket.on('close',()=>upstream.destroy());return needed;
  });});const socksPort=await listen(socks);
  const web=http.createServer((req,res)=>{counters.http++;res.writeHead(200,{'Content-Type':'text/plain'});res.end('DIRECT-LOOPBACK-OK');});const webPort=await listen(web);
  const dnsPort=await freePort(), mixedPort=await freePort(), controlDnsPort=await freePort();
  const config=JSON.parse(fs.readFileSync(inputPath,'utf8'));
  const localTag=config.dns.servers.find(s=>s.tag==='local'||s.tag==='provider-local'||s.tag.startsWith('cloakwire-local')).tag;
  config.log={level:'debug',timestamp:true};
  config.dns.servers=config.dns.servers.map(s=>['fakeip','hosts'].includes(s.type)?s:(s.tag==='local'||s.tag==='provider-local'||s.tag.startsWith('cloakwire-local'))
    ?{type:'udp',tag:s.tag,server:'127.0.0.1',server_port:localPort}
    :{type:'tcp',tag:s.tag,server:'127.0.0.1',server_port:remotePort,detour:'proxy'});
  config.dns.timeout='500ms';
  if(crossCache){
    config.dns.rules=[{inbound:['dns-local-control'],action:'route',server:localTag},...(config.dns.rules||[])];
  }
  // The Rust unit test pins the exact shared-owner names. Alias only those
  // names to this real node.exe socket owner, avoiding any live Windows service.
  if(sharedOwner) {
    config.dns.rules=config.dns.rules.map(r=>r.process_name
      ?{...r,process_name:r.process_name.map(name=>['svchost.exe','System'].includes(name)?'node.exe':name)}:r);
  }
  config.inbounds=[{type:'direct',tag:'dns-simulation',listen:'127.0.0.1',listen_port:dnsPort,network:'udp',override_address:'127.0.0.1',override_port:53},{type:'mixed',tag:'mixed-simulation',listen:'127.0.0.1',listen_port:mixedPort}];
  if(crossCache)config.inbounds.push({type:'direct',tag:'dns-local-control',listen:'127.0.0.1',listen_port:controlDnsPort,network:'udp',override_address:'127.0.0.1',override_port:53});
  config.outbounds=[{type:'socks',tag:'proxy',server:hostnameProxy?'proxy-endpoint.test':'127.0.0.1',server_port:socksPort,version:'5'},{type:'direct',tag:'direct'}];
  config.route.auto_detect_interface=false;
  // Keep the real generator/ready bootstrap policy: never repair it in the fixture.
  if(sharedOwner)config.route.rules=config.route.rules.map(r=>r.process_name
    ?{...r,process_name:r.process_name.map(name=>name==='bank.exe'?'node.exe':name)}:r);
  config.route.rules=config.route.rules.map(r=>r.outbound&&r.outbound!=='direct'?{...r,outbound:'proxy'}:r);
  if(config.route.final!=='direct')config.route.final='proxy';
  delete config.experimental;

  const configPath=path.join(dir,'loopback-config.json');fs.writeFileSync(configPath,JSON.stringify(config,null,2));
  const check=spawnSync(bin,['check','-c',configPath],{encoding:'utf8',windowsHide:true});record('config-check',{exitCode:check.status,stdout:check.stdout,stderr:check.stderr});assert.equal(check.status,0);
  child=spawn(bin,['run','-c',configPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>coreLog+=chunk.toString());child.stderr.on('data',chunk=>coreLog+=chunk.toString());
  for(let i=0;i<50&&!coreLog.includes('sing-box started');i++){if(child.exitCode!==null)throw Error('sing-box exited: '+coreLog);await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(coreLog.includes('sing-box started'),coreLog);
  record('scope',{corePid:child.pid,nodePid:process.pid,addresses:'all 127.0.0.1',tun:false,systemProxy:false,ports:{dnsPort,mixedPort,localPort,remotePort,socksPort,webPort}});
  if(crossCache){
    const prime=await dnsQuery(controlDnsPort,'cross-cache.test');record('local-control-caches-same-name',prime);assert.equal(prime.rcode,0);assert.equal(prime.answers,1);
    const count=counters.localUdp;
    const isolated=await dnsQuery(dnsPort,'cross-cache.test');record('vpn-must-not-consume-local-cache',isolated);assert.ok(isolated.error||isolated.rcode!==0);assert.equal(counters.localUdp,count);
  }
  const failedDns=await dnsQuery(dnsPort,'uncached-outage.test');record('proxy-failed-native-style-dns',failedDns);
  if(expected==='direct'){assert.equal(failedDns.rcode,0);assert.equal(failedDns.answers,1);assert.ok(counters.localUdp>0);assert.equal(counters.proxyConnect,0);}
  else {assert.ok(failedDns.error||failedDns.rcode!==0);assert.ok(localQueries.every(name=>name==='proxy-endpoint.test'||(crossCache&&name==='cross-cache.test')),'explicit VPN query must never fall back to local');assert.ok(counters.proxyRejected>0);}
  if(flags.includes('provider-fakeip')){
    const answer=await otherOwnerDns(dnsPort,'fakeip-unmatched.test');
    record('provider-fakeip-unmatched-owner',{rcode:answer.readUInt16BE(2)&15,answers:answer.readUInt16BE(6),address:[...answer.subarray(-4)].join('.')});
    assert.equal(answer.readUInt16BE(2)&15,0);assert.equal(answer.readUInt16BE(6),1);
    assert.equal(answer.at(-4),198);assert.ok([18,19].includes(answer.at(-3)),'unmatched owner must retain provider fake-IP');
  }
  const directIp=await proxyHttp(mixedPort,`http://127.0.0.1:${webPort}/ip`);record('proxy-failed-direct-ip-http',directIp);assert.equal(directIp.status,200);
  const directDomain=await proxyHttp(mixedPort,`http://direct-domain.test:${webPort}/domain`);record('proxy-failed-hostname-http',directDomain);if(expected==='direct'||sharedOwner)assert.equal(directDomain.status,200);else assert.ok(directDomain.error||directDomain.status!==200);
  const upstreamBeforeAaaa=counters.localUdp+counters.remoteTcp;
  const aaaa=await dnsQuery(dnsPort,'ipv6-only-query.test',28);record('proxy-failed-AAAA',aaaa);
  if(config.dns.strategy==='ipv4_only'){assert.equal(aaaa.rcode,0);assert.equal(aaaa.answers,0);assert.equal(counters.localUdp+counters.remoteTcp,upstreamBeforeAaaa);}
  proxyAvailable=true;
  const healthyDns=await dnsQuery(dnsPort,'cache-demo.test');record('proxy-healthy-native-style-dns',healthyDns);assert.equal(healthyDns.rcode,0);assert.equal(healthyDns.answers,1);
  proxyAvailable=false;
  for(const socket of sockets){if(socket!==undefined)socket.destroy();}
  const cached=await dnsQuery(dnsPort,'cache-demo.test');record('proxy-failed-cached-native-style-dns',cached);assert.equal(cached.rcode,0);assert.equal(cached.answers,1);
  const uncached=await dnsQuery(dnsPort,'fresh-after-outage.test');record('proxy-failed-fresh-native-style-dns',uncached);
  const directAgain=await proxyHttp(mixedPort,`http://127.0.0.1:${webPort}/again`);record('proxy-failed-direct-ip-still-works',directAgain);assert.equal(directAgain.status,200);
  if(expected==='direct'){assert.equal(uncached.rcode,0);assert.equal(uncached.answers,1);}
  else {assert.ok(uncached.error||uncached.rcode!==0);assert.ok(localQueries.every(name=>name==='proxy-endpoint.test'||(crossCache&&name==='cross-cache.test')||(sharedOwner&&name==='direct-domain.test')),'explicit VPN DNS must never use local DNS');assert.ok(counters.remoteTcp>0);}
  record('passed',{checks:8});
}
main().catch(error=>{record('FAILED',{message:error.message,stack:error.stack});process.exitCode=1;}).finally(async()=>{
  if(child&&child.exitCode===null){child.kill();await Promise.race([once(child,'exit'),new Promise(resolve=>setTimeout(resolve,1000))]);}
  for(const socket of sockets)socket.destroy();
  for(const server of servers){try{server.close();}catch{}}
  fs.writeFileSync(path.join(dir,'loopback-core.log'),coreLog);
  fs.writeFileSync(path.join(dir,'loopback-results.json'),JSON.stringify(observations,null,2));
});
