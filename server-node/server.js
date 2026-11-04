/* EduGames class server for Render: the same rooms and class lists as the Cloudflare Worker (../server),
   for networks that block workers.dev. Everything lives in memory; nothing is written to disk.
   Env: PORT (Render sets it), AUTH_SECRET (the same secret as the Cloudflare Worker, so a teacher's sign-in works here too),
   CLASSES_JSON (the class lists, as JSON text). auth.js is a copy of ../server/src/auth.js. */
import http from 'node:http';
import {WebSocketServer} from 'ws';
import {webcrypto} from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const {verifyToken} = await import('./auth.js');

const SECRET = process.env.AUTH_SECRET || '';
let CLASSES = [];
try { CLASSES = JSON.parse(process.env.CLASSES_JSON || '[]'); } catch (e) { console.error('CLASSES_JSON is not valid JSON'); }
const CORS = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': '*'};
const CID_OK = /^[A-Za-z0-9_-]{4,40}$/;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname.replace(/\/+$/, '');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (p === '' || p === '/health') { res.writeHead(200, {...CORS, 'Content-Type': 'text/plain'}); return res.end('EduGames class server: ok'); }
  if (p === '/classes') {
    if (!SECRET) { res.writeHead(503, CORS); return res.end('No AUTH_SECRET set on the server'); }
    const m = /^Bearer (.+)$/.exec(req.headers['authorization'] || '');
    verifyToken(m ? m[1] : '', SECRET).then(t => {
      if (!t) { res.writeHead(401, CORS); return res.end('Please sign in'); }
      res.writeHead(200, {...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(CLASSES));
    });
    return;
  }
  res.writeHead(404, CORS); res.end('Not found');
});

/* rooms: code -> {host: ws|null, key, guests: Map(cid -> ws)} */
const rooms = new Map();
const room = code => { let r = rooms.get(code); if (!r) { r = {host: null, key: null, guests: new Map()}; rooms.set(code, r); } return r; };
const send = (ws, o) => { try { if (ws && ws.readyState === 1) ws.send(typeof o === 'string' ? o : JSON.stringify(o)); } catch (e) {} };
const tidy = code => { const r = rooms.get(code); if (r && !r.host && !r.guests.size) rooms.delete(code); };

const wss = new WebSocketServer({noServer: true, maxPayload: 65536});
server.on('upgrade', (req, sock, head) => {
  const url = new URL(req.url, 'http://x'), m = /^\/room\/([A-Z0-9]{5})$/.exec(url.pathname);
  if (!m) { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, ws => onSocket(ws, m[1], url.searchParams));
});

function onSocket(ws, code, q) {
  const role = q.get('role'), r = room(code);
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  if (role === 'host') {
    const key = q.get('key') || '';
    if (r.host && r.key !== key) { send(ws, {ev: 'taken'}); ws.close(1008, 'taken'); return; }
    if (r.host) { const old = r.host; old.replaced = true; try { old.close(1000, 'replaced'); } catch (e) {} }
    r.host = ws; r.key = key; ws.role = 'host';
    send(ws, {ev: 'open', guests: [...r.guests.keys()]});
    r.guests.forEach(g => send(g, {ev: 'host'}));
  } else if (role === 'guest') {
    const cid = q.get('cid') || '';
    if (!CID_OK.test(cid)) { ws.close(1008, 'bad id'); return; }
    if (!r.host) { send(ws, {ev: 'nohost'}); ws.close(1000, 'nohost'); tidy(code); return; }
    const old = r.guests.get(cid); if (old) { old.replaced = true; try { old.close(1000, 'replaced'); } catch (e) {} }
    r.guests.set(cid, ws); ws.role = 'guest'; ws.cid = cid;
    send(ws, {ev: 'open'}); send(r.host, {ev: 'join', f: cid});
  } else { ws.close(1008, 'bad role'); return; }

  ws.on('message', (raw, isBin) => {
    if (isBin) return; let o; try { o = JSON.parse(String(raw)); } catch (e) { return; }
    if (!o || typeof o !== 'object' || o.ping) return;
    if (ws.role === 'host' && r.host === ws) {
      if (typeof o.kick === 'string') { const g = r.guests.get(o.kick); if (g) g.close(4000, 'removed'); return; }
      if (!('m' in o)) return; const out = JSON.stringify(o.m);
      if (o.to === '*') r.guests.forEach(g => send(g, out)); else if (typeof o.to === 'string') send(r.guests.get(o.to), out);
    } else if (ws.role === 'guest' && r.guests.get(ws.cid) === ws) send(r.host, {f: ws.cid, m: o});
  });
  ws.on('close', () => {
    if (ws.role === 'host' && r.host === ws) { r.host = null; if (!ws.replaced) r.guests.forEach(g => send(g, {ev: 'hostleft'})); }
    if (ws.role === 'guest' && r.guests.get(ws.cid) === ws) { r.guests.delete(ws.cid); if (!ws.replaced) send(r.host, {ev: 'leave', f: ws.cid}); }
    tidy(code);
  });
}
/* drop dead connections (phone went to sleep, Wi-Fi lost) */
setInterval(() => wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch (e) {} }), 30000);

const port = +process.env.PORT || 10000;
server.listen(port, () => console.log('EduGames class server on port', port));
