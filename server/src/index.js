import CLASSES from './classes.json';
import TEACHERS from './teachers.json';
import {checkPassword, hashPassword, signToken, verifyToken, bearer, b64u} from './auth.js';
/* EduGames class connection server: a tiny PeerJS-compatible signalling server on Cloudflare Workers.
   It only passes the short "how do I reach you" messages (offer, answer, ICE candidates) between the teacher's
   and the students' browsers. Game data then flows directly between the devices; nothing is stored here.

   v2: class rooms relayed through the server (/room/<CODE>): works on any network that allows HTTPS, no direct
   device-to-device link needed. Teachers sign in with their own account (/login; accounts live in the Store Durable Object, managed by the
   admin on the portal's Teachers page; src/teachers.json only seeds or rescues accounts). Sign-ins are tokens
   signed with the AUTH_SECRET secret. Class lists (/classes), reports (/reports) and /account need a sign-in.

   Routes (PeerJS client with {host, port: 443, path: '/', secure: true, key: 'peerjs'}):
     GET  /peerjs/id         -> a random peer id (text)
     GET  /peerjs?id=&token= -> WebSocket upgrade, handled by the Hub Durable Object
     GET  /                  -> "ok" (health check) */

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
    if (p === '/login' || p === '/classes' || p === '/reports' || p === '/account' || p === '/teachers') {
      if (!env.AUTH_SECRET) return new Response('No AUTH_SECRET set on the server', {status: 503, headers: CORS});
      return env.STORE.get(env.STORE.idFromName('reports')).fetch(req);
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
const U_OK = /^[a-z0-9._-]{2,30}$/;
const ABC = 'abcdefghjkmnpqrstuvwxyz23456789';
const makePassword = () => [...crypto.getRandomValues(new Uint8Array(10))].map(x => ABC[x % ABC.length]).join('').replace(/(.{5})/, '$1-');
const month = t => new Date(t).toISOString().slice(0, 7);

/* Everything that needs a sign-in, in one Durable Object:
   accounts (acct:<u>), saved class sessions (s:<id> + m:<id>), wrong-password locks (lock:<u>).
   POST /login {u, p}                  -> {token, u, name, role, mustChange, exp}
   GET  /account                       -> who is signed in
   POST /account {action:'password', old, new} -> new token (other devices are signed out)
   POST /account {action:'signout-all'}         -> every device of this teacher is signed out
   GET  /teachers                      -> (admin) the accounts with last sign-in and sessions per month
   POST /teachers {action:'add'|'reset'|'remove'|'rename', u, name?, p?} -> (admin) {password} for add/reset
   GET  /classes                       -> the class lists
   POST /reports {session}             -> saved for this teacher (kept if the stored copy is newer)
   GET  /reports?after=<ms>            -> this teacher's sessions (the admin gets everyone's), newest first */
export class Store {
  constructor(state, env) { this.state = state; this.env = env; this.seeded = false; }
  json(o, status = 200) { return new Response(JSON.stringify(o), {status, headers: {...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store'}}); }
  async body(req) { try { return JSON.parse(await req.text()); } catch (e) { return {}; } }
  /* accounts in teachers.json are copied in once per password hash: the Terminal script can still rescue a locked-out admin */
  async seed() {
    if (this.seeded) return; this.seeded = true;
    for (const t of TEACHERS) {
      if (!t || !U_OK.test(t.u) || !t.hash) continue;
      if ((await this.state.storage.get('seeded:' + t.u)) === t.hash) continue;
      const old = await this.state.storage.get('acct:' + t.u);
      await this.state.storage.put('acct:' + t.u, {u: t.u, name: t.name || t.u, role: t.role === 'admin' ? 'admin' : 'teacher', salt: t.salt, iter: t.iter || 100000, hash: t.hash,
        mustChange: false, gen: ((old && old.gen) || 0) + 1, created: (old && old.created) || Date.now(), lastSeen: old && old.lastSeen});
      await this.state.storage.put('seeded:' + t.u, t.hash);
    }
  }
  async token(acc) { const exp = Date.now() + 60 * 864e5; return {token: await signToken({u: acc.u, g: acc.gen, exp}, this.env.AUTH_SECRET), u: acc.u, name: acc.name, role: acc.role, mustChange: !!acc.mustChange, exp}; }
  async who(req) {
    const t = await verifyToken(bearer(req), this.env.AUTH_SECRET);
    const acc = t && await this.state.storage.get('acct:' + t.u);
    if (!acc || acc.gen !== t.g) return null;
    if (!acc.lastSeen || Date.now() - acc.lastSeen > 10 * 60000) { acc.lastSeen = Date.now(); await this.state.storage.put('acct:' + acc.u, acc); }
    return acc;
  }
  async setPassword(acc, pw, mustChange) { acc.salt = b64u(crypto.getRandomValues(new Uint8Array(16))); acc.iter = 100000; acc.hash = await hashPassword(pw, acc.salt); acc.mustChange = mustChange; acc.gen = (acc.gen || 0) + 1; }
  async fetch(req) {
    await this.seed();
    const url = new URL(req.url), p = url.pathname.replace(/\/+$/, '');
    if (p === '/login') return req.method === 'POST' ? this.login(req) : this.json({error: 'Use POST'}, 405);
    const me = await this.who(req);
    if (!me) return this.json({error: 'signin'}, 401);
    const admin = me.role === 'admin';
    if (p === '/classes') return this.json(CLASSES);
    if (p === '/account') return this.account(req, me);
    if (p === '/teachers') return admin ? this.teachers(req, me) : this.json({error: 'admin only'}, 403);
    if (req.method === 'POST') {
      const body = await req.text();
      if (body.length > 1900000) return this.json({error: 'Too big'}, 413);
      let s; try { s = JSON.parse(body).session; } catch (e) { return this.json({error: 'Bad JSON'}, 400); }
      if (!s || typeof s.id !== 'string' || !/^s[a-z0-9]{4,20}$/.test(s.id)) return this.json({error: 'Bad session'}, 400);
      const at = +s.updatedAt || Date.now(), old = await this.state.storage.get('m:' + s.id);
      if (old && old.owner && old.owner !== me.u && !admin) return this.json({error: 'Not your session'}, 403);
      if (old && old.at > at) return this.json({ok: true, kept: 'newer'});
      const owner = (old && old.owner) || me.u, started = (old && old.started) || Date.parse(s.startedAt) || at;
      s.owner = owner;
      await this.state.storage.put({['s:' + s.id]: JSON.stringify(s), ['m:' + s.id]: {at, owner, started}});
      return this.json({ok: true, at});
    }
    const after = +url.searchParams.get('after') || 0;
    const meta = await this.state.storage.list({prefix: 'm:'});
    const ids = [...meta].filter(([, m]) => m.at > after && (admin || m.owner === me.u)).sort((a, b) => b[1].at - a[1].at).slice(0, 300).map(([k]) => k.slice(2));
    const vals = new Map();
    for (let i = 0; i < ids.length; i += 100) (await this.state.storage.get(ids.slice(i, i + 100).map(id => 's:' + id))).forEach((v, k) => vals.set(k, v));
    return this.json(ids.map(id => { try { return JSON.parse(vals.get('s:' + id)); } catch (e) { return null; } }).filter(Boolean));
  }
  async login(req) {
    const b = await this.body(req);
    const u = String(b.u || '').trim().toLowerCase().slice(0, 40), key = 'lock:' + u, now = Date.now();
    const lock = (await this.state.storage.get(key)) || {n: 0, until: 0};
    if (lock.until > now) return this.json({error: 'locked', minutes: Math.ceil((lock.until - now) / 60000)}, 429);
    const acc = U_OK.test(u) && await this.state.storage.get('acct:' + u);
    if (!acc || !(await checkPassword(acc, b.p))) {
      lock.n = (lock.until ? 0 : lock.n) + 1; lock.until = 0;
      if (lock.n >= 8) { lock.until = now + 15 * 60000; lock.n = 0; }
      await this.state.storage.put(key, lock);
      return this.json({error: 'wrong'}, 403);
    }
    if (lock.n || lock.until) await this.state.storage.delete(key);
    acc.lastSeen = now; await this.state.storage.put('acct:' + u, acc);
    return this.json(await this.token(acc));
  }
  async account(req, me) {
    if (req.method !== 'POST') return this.json({u: me.u, name: me.name, role: me.role, mustChange: !!me.mustChange});
    const b = await this.body(req);
    if (b.action === 'signout-all') { me.gen = (me.gen || 0) + 1; await this.state.storage.put('acct:' + me.u, me); return this.json({ok: true}); }
    if (b.action === 'password') {
      const pw = String(b.new || '');
      if (!me.mustChange && !(await checkPassword(me, b.old))) return this.json({error: 'wrong'}, 403);
      if (pw.length < 6 || pw.length > 100) return this.json({error: 'short'}, 400);
      await this.setPassword(me, pw, false); await this.state.storage.put('acct:' + me.u, me);
      return this.json(await this.token(me));
    }
    return this.json({error: 'Unknown action'}, 400);
  }
  async teachers(req, me) {
    if (req.method === 'POST') {
      const b = await this.body(req), u = String(b.u || '').trim().toLowerCase(), name = String(b.name || '').trim().slice(0, 60);
      if (!U_OK.test(u)) return this.json({error: 'username'}, 400);
      const acc = await this.state.storage.get('acct:' + u);
      if (b.action === 'add') {
        if (acc) return this.json({error: 'exists'}, 409);
        if (!name) return this.json({error: 'name'}, 400);
        const pw = String(b.p || '') || makePassword(); if (pw.length < 6) return this.json({error: 'short'}, 400);
        const n = {u, name, role: b.role === 'admin' ? 'admin' : 'teacher', created: Date.now(), gen: 0};
        await this.setPassword(n, pw, true); await this.state.storage.put('acct:' + u, n);
        return this.json({ok: true, password: pw});
      }
      if (!acc) return this.json({error: 'missing'}, 404);
      if (b.action === 'reset') {
        const pw = String(b.p || '') || makePassword(); if (pw.length < 6) return this.json({error: 'short'}, 400);
        await this.setPassword(acc, pw, true); await this.state.storage.put('acct:' + u, acc); await this.state.storage.delete('lock:' + u);
        return this.json({ok: true, password: pw});
      }
      if (b.action === 'rename') { if (!name) return this.json({error: 'name'}, 400); acc.name = name; await this.state.storage.put('acct:' + u, acc); return this.json({ok: true}); }
      if (b.action === 'remove') { if (u === me.u) return this.json({error: 'self'}, 400); await this.state.storage.delete('acct:' + u); return this.json({ok: true}); }
      return this.json({error: 'Unknown action'}, 400);
    }
    const accs = [...(await this.state.storage.list({prefix: 'acct:'})).values()];
    const meta = [...(await this.state.storage.list({prefix: 'm:'})).values()], now = month(Date.now());
    const count = (u, mon) => meta.filter(m => (m.owner || '') === u && (!mon || month(m.started || m.at) === mon)).length;
    return this.json({month: now, teachers: accs.sort((a, b) => (a.role === 'admin' ? 0 : 1) - (b.role === 'admin' ? 0 : 1) || a.name.localeCompare(b.name)).map(a => ({u: a.u, name: a.name, role: a.role, created: a.created || null, lastSeen: a.lastSeen || null, mustChange: !!a.mustChange, month: count(a.u, now), total: count(a.u)})),
      unassigned: count('')});
  }
}
