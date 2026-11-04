import CLASSES from './classes.json';
import TEACHERS from './teachers.json';
import {checkPassword, signToken, verifyToken, bearer} from './auth.js';
/* EduGames class connection server: a tiny PeerJS-compatible signalling server on Cloudflare Workers.
   It only passes the short "how do I reach you" messages (offer, answer, ICE candidates) between the teacher's
   and the students' browsers. Game data then flows directly between the devices; nothing is stored here.

   v2: class rooms relayed through the server (/room/<CODE>): works on any network that allows HTTPS, no direct
   device-to-device link needed. Teachers sign in with their own account (/login, accounts in src/teachers.json,
   tokens signed with the AUTH_SECRET secret); class lists (/classes) and reports (/reports) need that sign-in.

   Routes (PeerJS client with {host, port: 443, path: '/', secure: true, key: 'peerjs'}):
     GET  /peerjs/id         -> a random peer id (text)
     GET  /peerjs?id=&token= -> WebSocket upgrade, handled by the Hub Durable Object
     GET  /                  -> "ok" (health check) */

/* the signed-in teacher, or null. A token stops working when its account is removed or its password is reset. */
async function teacher(req, env) {
  const t = await verifyToken(bearer(req), env.AUTH_SECRET);
  const acc = t && TEACHERS.find(a => a.u === t.u);
  return acc && acc.hash.slice(0, 8) === t.v ? {u: acc.u, name: acc.name, role: acc.role} : null;
}
const CORS = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': '*'};
const ID_OK = /^[A-Za-z0-9_-][A-Za-z0-9_ -]{0,62}[A-Za-z0-9_-]?$/;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, {headers: CORS});
    const p = url.pathname.replace(/\/+$/, '');
    if (p === '/peerjs/id') return new Response(crypto.randomUUID(), {headers: {...CORS, 'Content-Type': 'text/plain', 'Cache-Control': 'no-store'}});
    if (p === '/peerjs') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', {status: 426, headers: CORS});
      const id = url.searchParams.get('id') || '';
      if (!ID_OK.test(id)) return new Response('Bad id', {status: 400, headers: CORS});
      return env.HUB.get(env.HUB.idFromName('hub')).fetch(req);
    }
    const room = /^\/room\/([A-Z0-9]{5})$/.exec(p);
    if (room) {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', {status: 426, headers: CORS});
      return env.ROOM.get(env.ROOM.idFromName(room[1])).fetch(req);
    }
    if (p === '/login') {
      /* username + password -> a signed token for 60 days; too many wrong tries lock the account for 15 minutes */
      if (req.method !== 'POST') return new Response('Use POST', {status: 405, headers: CORS});
      if (!env.AUTH_SECRET) return new Response('No AUTH_SECRET set on the server', {status: 503, headers: CORS});
      return env.STORE.get(env.STORE.idFromName('reports')).fetch(new Request('https://store/login', {method: 'POST', body: await req.text()}));
    }
    if (p === '/classes' || p === '/reports') {
      const who = await teacher(req, env);
      if (!who) return new Response('Please sign in', {status: 401, headers: CORS});
      if (p === '/classes') return new Response(JSON.stringify(CLASSES), {headers: {...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store'}});
      const h = new Headers({'X-Edu-User': who.u, 'X-Edu-Role': who.role});
      return env.STORE.get(env.STORE.idFromName('reports')).fetch(new Request(url.toString(), {method: req.method, headers: h, body: req.method === 'POST' ? await req.text() : undefined}));
    }
    if (p === '' || p === '/health') return new Response('EduGames class server: ok', {headers: {...CORS, 'Content-Type': 'text/plain'}});
    return new Response('Not found', {status: 404, headers: CORS});
  }
};

/* One Hub holds every open connection, tagged by peer id. WebSocket hibernation keeps it free while idle. */
export class Hub {
  constructor(state) { this.state = state; }

  async fetch(req) {
    const url = new URL(req.url);
    const id = url.searchParams.get('id'), token = url.searchParams.get('token') || '';
    const pair = new WebSocketPair(), [client, server] = Object.values(pair);
    const old = this.state.getWebSockets(id);
    if (old.length) {
      /* same browser reconnecting (same token): replace the old socket; anyone else: the id is taken */
      const same = old.some(ws => (ws.deserializeAttachment() || {}).token === token);
      if (!same) {
        this.state.acceptWebSocket(server, ['_taken']);
        server.send(JSON.stringify({type: 'ID-TAKEN', payload: {msg: 'ID is taken'}}));
        server.close(1008, 'ID is taken');
        return new Response(null, {status: 101, webSocket: client});
      }
      old.forEach(ws => { try { ws.close(1000, 'Replaced'); } catch (e) {} });
    }
    this.state.acceptWebSocket(server, [id]);
    server.serializeAttachment({id, token});
    server.send(JSON.stringify({type: 'OPEN'}));
    return new Response(null, {status: 101, webSocket: client});
  }

  webSocketMessage(ws, raw) {
    const me = (ws.deserializeAttachment() || {}).id;
    if (!me || typeof raw !== 'string' || raw.length > 65536) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.type === 'HEARTBEAT') return;
    if (!['OFFER', 'ANSWER', 'CANDIDATE', 'LEAVE', 'EXPIRE'].includes(m.type) || typeof m.dst !== 'string') return;
    const to = this.state.getWebSockets(m.dst).filter(s => (s.deserializeAttachment() || {}).id === m.dst);
    if (!to.length) {
      /* nobody with that id: tell the sender, so the student sees "No open class with code …" */
      if (m.type !== 'LEAVE' && m.type !== 'EXPIRE') ws.send(JSON.stringify({type: 'EXPIRE', src: m.dst, dst: me}));
      return;
    }
    const out = JSON.stringify({type: m.type, src: me, dst: m.dst, payload: m.payload});
    to.forEach(s => { try { s.send(out); } catch (e) {} });
  }

  webSocketClose(ws) { try { ws.close(); } catch (e) {} }
  webSocketError(ws) { try { ws.close(); } catch (e) {} }
}

/* One Room per class code. The teacher's browser is the host; students are guests. Messages:
   guest -> server: any JSON         -> host gets {f: <guest id>, m: <message>}
   host  -> server: {to: id|'*', m}   -> that guest (or all) gets m;  {kick: id} closes that guest
   server -> host:  {ev:'open', guests:[ids]}, {ev:'join', f}, {ev:'leave', f}, {ev:'taken'}
   server -> guest: {ev:'open'}, {ev:'nohost'}, {ev:'hostleft'}, {ev:'host'}
   {ping:1} from anyone keeps the line alive and is ignored. */
const CID_OK = /^[A-Za-z0-9_-]{4,40}$/;
export class Room {
  constructor(state) { this.state = state; }
  att(ws) { try { return ws.deserializeAttachment() || {}; } catch (e) { return {}; } }
  host() { return this.state.getWebSockets('host')[0] || null; }
  guests(id) { return this.state.getWebSockets(id ? 'g:' + id : 'guest'); }
  send(ws, o) { try { ws.send(typeof o === 'string' ? o : JSON.stringify(o)); } catch (e) {} }

  async fetch(req) {
    const url = new URL(req.url), role = url.searchParams.get('role');
    const pair = new WebSocketPair(), [client, server] = Object.values(pair);
    const done = () => new Response(null, {status: 101, webSocket: client});
    if (role === 'host') {
      const key = url.searchParams.get('key') || '';
      const old = this.state.getWebSockets('host');
      if (old.some(ws => this.att(ws).key !== key)) {
        this.state.acceptWebSocket(server, ['dead']); this.send(server, {ev: 'taken'}); server.close(1008, 'taken'); return done();
      }
      old.forEach(ws => { try { ws.close(1000, 'replaced'); } catch (e) {} });
      this.state.acceptWebSocket(server, ['host']); server.serializeAttachment({role: 'host', key});
      this.send(server, {ev: 'open', guests: this.guests().map(ws => this.att(ws).cid)});
      this.guests().forEach(g => this.send(g, {ev: 'host'}));
      return done();
    }
    const cid = url.searchParams.get('cid') || '';
    if (role !== 'guest' || !CID_OK.test(cid)) return new Response('Bad request', {status: 400});
    if (!this.host()) { this.state.acceptWebSocket(server, ['dead']); this.send(server, {ev: 'nohost'}); server.close(1000, 'nohost'); return done(); }
    this.guests(cid).forEach(ws => { try { ws.close(1000, 'replaced'); } catch (e) {} });
    this.state.acceptWebSocket(server, ['guest', 'g:' + cid]); server.serializeAttachment({role: 'guest', cid});
    this.send(server, {ev: 'open'});
    const h = this.host(); if (h) this.send(h, {ev: 'join', f: cid});
    return done();
  }

  webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 65536) return;
    let o; try { o = JSON.parse(raw); } catch (e) { return; }
    if (!o || typeof o !== 'object' || o.ping) return;
    const a = this.att(ws);
    if (a.role === 'host') {
      if (typeof o.kick === 'string') { this.guests(o.kick).forEach(g => { try { g.close(4000, 'removed'); } catch (e) {} }); return; }
      if (!('m' in o)) return;
      const out = JSON.stringify(o.m);
      (o.to === '*' ? this.guests() : typeof o.to === 'string' ? this.guests(o.to) : []).forEach(g => this.send(g, out));
    } else if (a.role === 'guest') {
      const h = this.host(); if (h) this.send(h, {f: a.cid, m: o});
    }
  }

  webSocketClose(ws) { this.gone(ws); }
  webSocketError(ws) { this.gone(ws); }
  gone(ws) {
    const a = this.att(ws);
    try { ws.close(); } catch (e) {}
    if (a.role === 'guest') { if (this.guests(a.cid).some(g => g !== ws)) return; const h = this.host(); if (h) this.send(h, {ev: 'leave', f: a.cid}); }
    if (a.role === 'host' && !this.state.getWebSockets('host').some(h => h !== ws)) this.guests().forEach(g => this.send(g, {ev: 'hostleft'}));
  }
}

/* Saved class sessions (rounds, results, answers), one record per session.
   POST /reports  {session}         -> saved (kept if the stored copy is newer)
   GET  /reports?after=<ms>         -> sessions changed after that time, newest first (up to 300) */
export class Store {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(req) {
    const url = new URL(req.url), J = {...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store'};
    if (url.pathname === '/login') return this.login(req, J);
    const me = req.headers.get('X-Edu-User') || '', admin = req.headers.get('X-Edu-Role') === 'admin';
    if (!me) return new Response('Please sign in', {status: 401, headers: CORS});
    if (req.method === 'POST') {
      const body = await req.text();
      if (body.length > 1900000) return new Response('Too big', {status: 413, headers: CORS});
      let s; try { s = JSON.parse(body).session; } catch (e) { return new Response('Bad JSON', {status: 400, headers: CORS}); }
      if (!s || typeof s.id !== 'string' || !/^s[a-z0-9]{4,20}$/.test(s.id)) return new Response('Bad session', {status: 400, headers: CORS});
      const at = +s.updatedAt || Date.now(), old = await this.state.storage.get('m:' + s.id);
      if (old && old.owner && old.owner !== me && !admin) return new Response('Not your session', {status: 403, headers: CORS});
      if (old && old.at > at) return new Response(JSON.stringify({ok: true, kept: 'newer'}), {headers: J});
      const owner = (old && old.owner) || me;
      s.owner = owner;
      await this.state.storage.put({['s:' + s.id]: JSON.stringify(s), ['m:' + s.id]: {at, owner}});
      return new Response(JSON.stringify({ok: true, at}), {headers: J});
    }
    const after = +url.searchParams.get('after') || 0;
    const meta = await this.state.storage.list({prefix: 'm:'});
    const ids = [...meta].filter(([, m]) => m.at > after && (admin || m.owner === me)).sort((a, b) => b[1].at - a[1].at).slice(0, 300).map(([k]) => k.slice(2));
    const vals = new Map();
    for (let i = 0; i < ids.length; i += 100) (await this.state.storage.get(ids.slice(i, i + 100).map(id => 's:' + id))).forEach((v, k) => vals.set(k, v));
    const out = ids.map(id => { try { return JSON.parse(vals.get('s:' + id)); } catch (e) { return null; } }).filter(Boolean);
    return new Response(JSON.stringify(out), {headers: J});
  }
  async login(req, J) {
    let b; try { b = JSON.parse(await req.text()); } catch (e) { b = {}; }
    const u = String(b.u || '').trim().toLowerCase().slice(0, 40), key = 'lock:' + u, now = Date.now();
    const lock = (await this.state.storage.get(key)) || {n: 0, until: 0};
    if (lock.until > now) return new Response(JSON.stringify({error: 'locked', minutes: Math.ceil((lock.until - now) / 60000)}), {status: 429, headers: J});
    const acc = TEACHERS.find(a => a.u === u);
    if (!acc || !(await checkPassword(acc, b.p))) {
      lock.n = (lock.until && lock.until <= now ? 0 : lock.n) + 1; lock.until = lock.n >= 8 ? now + 15 * 60000 : 0;
      if (lock.until) lock.n = 0;
      await this.state.storage.put(key, lock);
      return new Response(JSON.stringify({error: 'wrong'}), {status: 403, headers: J});
    }
    if (lock.n) await this.state.storage.delete(key);
    const exp = now + 60 * 864e5;
    const token = await signToken({u: acc.u, v: acc.hash.slice(0, 8), exp}, this.env.AUTH_SECRET);
    return new Response(JSON.stringify({token, u: acc.u, name: acc.name, role: acc.role, exp}), {headers: J});
  }
}
