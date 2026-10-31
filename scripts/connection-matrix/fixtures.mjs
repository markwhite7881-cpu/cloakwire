import { randomUUID } from 'node:crypto';
export function loopbackFixtures({ serverPort, proxyPort, wrongUser = false }) {
  const id = randomUUID();
  const user = wrongUser ? randomUUID() : id;
  return {
    server: { log: { loglevel: 'none' }, inbounds: [{ tag: 'fixture-server', listen: '127.0.0.1', port: serverPort, protocol: 'vless', settings: { clients: [{ id }], decryption: 'none' } }], outbounds: [{ protocol: 'freedom' }] },
    'sing-box': { log: { disabled: true }, inbounds: [{ type: 'http', tag: 'fixture-in', listen: '127.0.0.1', listen_port: proxyPort }], outbounds: [{ type: 'vless', tag: 'fixture-out', server: '127.0.0.1', server_port: serverPort, uuid: user }], route: { final: 'fixture-out' } },
    xray: { log: { loglevel: 'none' }, inbounds: [{ protocol: 'http', tag: 'fixture-in', listen: '127.0.0.1', port: proxyPort }], outbounds: [{ protocol: 'vless', tag: 'fixture-out', settings: { vnext: [{ address: '127.0.0.1', port: serverPort, users: [{ id: user, encryption: 'none' }] }] } }] },
  };
}
export const checkArgs = (engine, config) => engine === 'sing-box' ? ['check', '-c', config] : ['run', '-test', '-c', config];
export const runArgs = (engine, config) => engine === 'sing-box' ? ['run', '-c', config] : ['run', '-c', config];
