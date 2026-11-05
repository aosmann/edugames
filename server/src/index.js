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
    if (p === '/login' || p === '/classes' || p === '/reports' || p === '/account' || p === '/teachers' || p === '/sets' || p.startsWith('/google')) {
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
/* rows for Google Sheets: one result -> its class tab (or Guests), All results, and one Mistakes row per missed question */
/* Sheet layout v2: every tab is a Google Sheets table with typed columns, plus an "Overview" tab of formulas.
   A column: [key, English name, Romanian name, type]; types are the Sheets table column types. */
const COLS = {
  date: ['Date', 'Data', 'DATE'], time: ['Time', 'Ora', 'TEXT'], teacher: ['Teacher', 'Profesor', 'TEXT'], cls: ['Class', 'Clasa', 'TEXT'],
  student: ['Student', 'Elev', 'TEXT'], game: ['Game', 'Joc', 'TEXT'], subject: ['Subject', 'Materie', 'TEXT'], topic: ['Topic', 'Temă', 'TEXT'],
  level: ['Level', 'Nivel', 'TEXT'], score: ['Score', 'Scor', 'DOUBLE'], right: ['Right', 'Corecte', 'DOUBLE'], asked: ['Asked', 'Întrebări', 'DOUBLE'],
  pct: ['% right', '% corecte', 'PERCENT'], early: ['Ended early', 'Oprit mai devreme', 'BOOLEAN'], guest: ['Guest', 'Invitat', 'BOOLEAN'],
  q: ['Question', 'Întrebare', 'TEXT'], picked: ['Their answer', 'Răspunsul lui', 'TEXT'], answer: ['Right answer', 'Răspuns corect', 'TEXT']};
const LAYOUT = admin => ({
  all: ['date', 'time', ...(admin ? ['teacher'] : []), 'cls', 'student', 'game', 'subject', 'topic', 'level', 'score', 'right', 'asked', 'pct', 'early', 'guest'],
  cls: ['date', 'time', ...(admin ? ['teacher'] : []), 'student', 'game', 'subject', 'topic', 'level', 'score', 'right', 'asked', 'pct', 'early'],
  mis: ['date', 'time', ...(admin ? ['teacher'] : []), 'cls', 'student', 'game', 'topic', 'q', 'picked', 'answer']});
const SHEET_TX = {
  en: {tabs: {ov: 'Overview', all: 'All results', mis: 'Mistakes', guests: 'Guests', none: 'No class list'}, level: {1: 'Easy', 2: 'Medium', 3: 'Hard'}, lang: 0,
    ov: {title: 'EduGames reports', note: 'Fills in by itself after every class. EduGames adds the rows; you can sort, filter and colour them as you like.', students: 'Students', classes: 'Classes', missed: 'Most missed questions', results: 'Results', wrong: 'Wrong'}},
  ro: {tabs: {ov: 'Pe scurt', all: 'Toate rezultatele', mis: 'Greșeli', guests: 'Invitați', none: 'Fără listă de clasă'}, level: {1: 'Ușor', 2: 'Mediu', 3: 'Greu'}, lang: 1,
    ov: {title: 'Rapoarte EduGames', note: 'Se completează singur după fiecare oră. EduGames adaugă rândurile; le poți sorta, filtra și colora cum vrei.', students: 'Elevi', classes: 'Clase', missed: 'Cele mai greșite întrebări', results: 'Rezultate', wrong: 'Greșeli'}}};
function when(t) {
  const d = new Date(t || Date.now()), x = new Intl.DateTimeFormat('en-GB', {timeZone: 'Europe/Bucharest', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false})
    .formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  const serial = Date.UTC(+x.year, +x.month - 1, +x.day) / 864e5 + 25569;   // a Sheets date: days since 30 Dec 1899
  return {day: `${x.year}-${x.month}-${x.day}`, serial, time: `${x.hour}:${x.minute}`};
}
const tabName = n => String(n || '').replace(/[\[\]\*\?\/\\:']/g, ' ').trim().slice(0, 90);
/* one result -> rows: {tab: 'all' | 'mis' | 'cls', name (class tab name), v: {key: value}} */
function sheetRows(s, rd, res, accs, L) {
  const w = when(res.at || rd.startedAt || s.startedAt), acc = accs.find(a => a.u === s.owner), teacher = acc ? acc.name : (s.owner || '');
  const cls = s.className || '', isGuest = (s.guests || []).includes(res.player), noList = !s.className;
  const lvl = rd.values && rd.values.level != null && !rd.setId ? (L.level[rd.values.level] || String(rd.values.level)) : '';
  const topic = (rd.topicName || rd.topic || '') + (rd.regionsLabel && rd.regionsLabel !== 'All continents' ? ' · ' + rd.regionsLabel : '');
  const base = {date: w.serial, time: w.time, teacher, cls: cls || '—', student: res.player, game: rd.gameName || rd.game || '', subject: rd.subjectName || rd.subject || '', topic, level: lvl,
    score: +res.score || 0, right: +res.right || 0, asked: +res.asked || 0, pct: res.asked ? (+res.right || 0) / res.asked : 0, early: !!res.partial, guest: isGuest};
  const out = [{tab: 'all', v: base}, {tab: 'cls', name: noList ? L.tabs.none : isGuest ? L.tabs.guests : tabName(cls), v: base}];
  (res.missed || []).forEach(m => out.push({tab: 'mis', v: {...base, q: m.q || '', picked: m.picked == null ? '' : String(m.picked), answer: m.answer == null ? '' : String(m.answer)}}));
  return out;
}
const cellOf = (type, v) => type === 'BOOLEAN' ? {userEnteredValue: {boolValue: !!v}} : (type === 'DOUBLE' || type === 'PERCENT' || type === 'DATE') ? {userEnteredValue: {numberValue: +v || 0}}
  : {userEnteredValue: {stringValue: v == null ? '' : String(v)}};
const colLetter = i => String.fromCharCode(65 + i);
const tblName = n => 'T_' + String(n).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
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
    if (p === '/google/callback') return this.gCallback(url);
    const me = await this.who(req);
    if (!me) return this.json({error: 'signin'}, 401);
    const admin = me.role === 'admin';
    if (p === '/classes') return this.json(CLASSES);
    if (p === '/account') return this.account(req, me);
    if (p === '/teachers') return admin ? this.teachers(req, me) : this.json({error: 'admin only'}, 403);
    if (p === '/google') return this.google(req, me);
    if (p === '/sets') return this.sets(req, me);
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
      await this.gQueue([s.id]);
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
  /* ---------------- Google Sheets: each teacher can connect a sheet in their own (school) Google Drive ----------------
     gs:<u> = {refresh, sheet, url, email, tabs:[...], at, err}; gx:<u>:<sid> = keys of results already sent; gq = queued session ids */
  gOn() { return !!(this.env.GOOGLE_CLIENT_ID && this.env.GOOGLE_CLIENT_SECRET); }
  gRedirect() { return (this.env.PUBLIC_URL || 'https://edugames-class.edugames.workers.dev') + '/google/callback'; }
  async google(req, me) {
    const key = 'gs:' + me.u, g = await this.state.storage.get(key);
    if (req.method !== 'POST') return this.json({available: this.gOn(), connected: !!(g && g.refresh), url: g && g.url, email: g && g.email, at: g && g.at, err: g && g.err, all: me.role === 'admin', old: g && g.old || null, v: g && g.v || 1});
    const b = await this.body(req);
    if (b.action === 'start') {
      if (!this.gOn()) return this.json({error: 'not set up'}, 503);
      const st = b64u(crypto.getRandomValues(new Uint8Array(18)));
      await this.state.storage.put('gstate:' + st, {u: me.u, lang: b.lang === 'ro' ? 'ro' : 'en', exp: Date.now() + 15 * 60000});
      const q = new URLSearchParams({client_id: this.env.GOOGLE_CLIENT_ID, redirect_uri: this.gRedirect(), response_type: 'code', access_type: 'offline', prompt: 'consent',
        scope: 'openid email https://www.googleapis.com/auth/drive.file', state: st, hd: this.env.GOOGLE_DOMAIN || 'spectrum.ro', include_granted_scopes: 'true'});
      return this.json({url: 'https://accounts.google.com/o/oauth2/v2/auth?' + q});
    }
    if (b.action === 'disconnect') {
      if (g && g.refresh) fetch((this.env.GOOGLE_TEST_URL || 'https://oauth2.googleapis.com') + '/revoke?token=' + encodeURIComponent(g.refresh), {method: 'POST'}).catch(() => {});
      await this.state.storage.delete(key); const old = await this.state.storage.list({prefix: 'gx:' + me.u + ':'}); if (old.size) await this.state.storage.delete([...old.keys()]);
      return this.json({ok: true});
    }
    if (b.action === 'rebuild') {
      if (!g || !g.refresh) return this.json({error: 'not connected'}, 400);
      try { const acc = await this.state.storage.get('acct:' + me.u), tok = await this.gToken(me.u, g); await this.gNewSheet(me.u, acc, b.lang === 'en' || b.lang === 'ro' ? b.lang : g.lang, tok, {refresh: g.refresh, email: g.email, old: g.url}); }
      catch (e) { return this.json({error: 'google'}, 502); }
      return this.json({ok: true});
    }
    if (b.action === 'resend') {
      if (!g || !g.refresh) return this.json({error: 'not connected'}, 400);
      const meta = await this.state.storage.list({prefix: 'm:'});
      const ids = [...meta].filter(([, m]) => me.role === 'admin' || m.owner === me.u).sort((a, c) => (a[1].started || a[1].at) - (c[1].started || c[1].at)).map(([k]) => k.slice(2));
      await this.gQueue(ids, 1000);
      return this.json({ok: true, sessions: ids.length});
    }
    return this.json({error: 'Unknown action'}, 400);
  }
  page(title, text, ok) {
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EduGames</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f2f4fa;font-family:system-ui,sans-serif;color:#18203d">
<div style="background:#fff;border-radius:26px;padding:32px 28px;max-width:380px;margin:16px;box-shadow:0 20px 60px -20px rgba(0,0,0,.25);text-align:center">
<div style="font-size:44px">${ok ? '✅' : '⚠️'}</div><h1 style="font-size:24px;margin:8px 0">${title}</h1><p style="color:#58618a;line-height:1.5">${text}</p>
<button onclick="window.close()" style="border:0;border-radius:16px;padding:14px 22px;font-weight:800;font-size:16px;background:#2b3990;color:#fff;margin-top:8px">OK</button></div>
<script>try{window.opener&&window.opener.postMessage({type:'edu-google',ok:${ok ? 'true' : 'false'}},'*')}catch(e){}${ok ? 'setTimeout(()=>window.close(),2500)' : ''}</script>`;
    return new Response(html, {headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'}});
  }
  async gCallback(url) {
    const st = url.searchParams.get('state') || '', code = url.searchParams.get('code'), info = await this.state.storage.get('gstate:' + st);
    if (st) await this.state.storage.delete('gstate:' + st);
    if (url.searchParams.get('error')) return this.page('Not connected', 'Google Sheets was not connected. You can try again from EduGames.', false);
    if (!info || info.exp < Date.now() || !code) return this.page('Link expired', 'Close this window and click “Connect Google Sheets” in EduGames again.', false);
    const acc = await this.state.storage.get('acct:' + info.u);
    if (!acc) return this.page('Not connected', 'Your EduGames account was not found.', false);
    const r = await fetch((this.env.GOOGLE_TEST_URL || 'https://oauth2.googleapis.com') + '/token', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({code, client_id: this.env.GOOGLE_CLIENT_ID, client_secret: this.env.GOOGLE_CLIENT_SECRET, redirect_uri: this.gRedirect(), grant_type: 'authorization_code'})});
    const t = await r.json().catch(() => ({}));
    if (!r.ok || !t.refresh_token) return this.page('Not connected', 'Google did not allow the connection. Try again, and use your school account.', false);
    let email = ''; try { email = JSON.parse(new TextDecoder().decode(Uint8Array.from((x => atob(x + '==='.slice((x.length + 3) % 4)))(t.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)))).email || ''; } catch (e) {}
    const dom = this.env.GOOGLE_DOMAIN || 'spectrum.ro';
    if (email && !email.toLowerCase().endsWith('@' + dom)) return this.page('School account needed', `Please connect with your @${dom} Google account.`, false);
    this.gTok = this.gTok || new Map(); this.gTok.set(info.u, {token: t.access_token, exp: Date.now() + (t.expires_in - 120) * 1000});
    const ro = info.lang === 'ro';
    let sh; try { sh = await this.gNewSheet(info.u, acc, info.lang, t.access_token, {refresh: t.refresh_token, email}); } catch (e) { sh = null; }
    if (!sh) return this.page('Not connected', 'Google Sheets could not create the sheet. Check that Google Sheets is turned on for your school account.', false);
    const title = sh.title;
    return ro ? this.page('Google Sheets conectat', `Rapoartele tale merg în „${title}”, în Google Drive-ul tău. Rapoartele de până acum se adaugă acum. Poți închide fereastra.`, true)
      : this.page('Google Sheets connected', `Your reports go to “${title}” in your Google Drive. Past reports are being added now. You can close this window.`, true);
  }
  async gQueue(ids, delay = 20000) {
    if (!this.gOn() || !ids.length) return;
    const q = (await this.state.storage.get('gq')) || []; ids.forEach(id => { if (!q.includes(id)) q.push(id); });
    await this.state.storage.put('gq', q.slice(-2000));
    const cur = await this.state.storage.getAlarm(); if (!cur || cur > Date.now() + delay) await this.state.storage.setAlarm(Date.now() + delay);
  }
  async gToken(u, g) {
    this.gTok = this.gTok || new Map(); const c = this.gTok.get(u); if (c && c.exp > Date.now()) return c.token;
    const r = await fetch((this.env.GOOGLE_TEST_URL || 'https://oauth2.googleapis.com') + '/token', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({client_id: this.env.GOOGLE_CLIENT_ID, client_secret: this.env.GOOGLE_CLIENT_SECRET, refresh_token: g.refresh, grant_type: 'refresh_token'})});
    const t = await r.json().catch(() => ({}));
    if (!r.ok || !t.access_token) { const e = new Error(t.error === 'invalid_grant' ? 'revoked' : 'token'); e.fatal = t.error === 'invalid_grant'; throw e; }
    this.gTok.set(u, {token: t.access_token, exp: Date.now() + (t.expires_in - 120) * 1000}); return t.access_token;
  }
  /* a new spreadsheet in the teacher's Drive: Overview (formulas), All results and Mistakes as tables; then every past session is queued */
  async gNewSheet(u, acc, lang, tok, extra) {
    const L = SHEET_TX[lang] || SHEET_TX.en, ro = lang === 'ro', admin = acc.role === 'admin', LY = LAYOUT(admin);
    const title = admin ? (ro ? 'Rapoarte EduGames – toți profesorii' : 'EduGames reports – all teachers') : (ro ? 'Rapoarte EduGames – ' : 'EduGames reports – ') + acc.name;
    const c = await fetch((this.env.GOOGLE_TEST_URL || 'https://sheets.googleapis.com') + '/v4/spreadsheets', {method: 'POST', headers: {Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json'},
      body: JSON.stringify({properties: {title, locale: 'en_GB', timeZone: 'Europe/Bucharest'}, sheets: [
        {properties: {sheetId: 0, title: L.tabs.ov, tabColorStyle: {rgbColor: {red: .17, green: .22, blue: .56}}, gridProperties: {hideGridlines: true}}},
        {properties: {sheetId: 1, title: L.tabs.all, tabColorStyle: {rgbColor: {red: .1, green: .61, blue: .37}}}},
        {properties: {sheetId: 2, title: L.tabs.mis, tabColorStyle: {rgbColor: {red: .84, green: .26, blue: .23}}}}]})});
    const sh = await c.json().catch(() => ({}));
    if (!c.ok || !sh.spreadsheetId) throw new Error('create');
    const g = {v: 2, refresh: extra.refresh, sheet: sh.spreadsheetId, url: sh.spreadsheetUrl, email: extra.email || '', lang, admin, old: extra.old || null, tabs: {}, next: 10, at: null, err: null};
    const base = (this.env.GOOGLE_TEST_URL || 'https://sheets.googleapis.com') + '/v4/spreadsheets/' + g.sheet;
    await this.gTable(tok, g, base, 'all', 1, L.tabs.all, LY.all, false);
    await this.gTable(tok, g, base, 'mis', 2, L.tabs.mis, LY.mis, false);
    await this.gOverview(tok, g, base, L, LY).catch(() => {});
    { const old = await this.state.storage.list({prefix: 'gx:' + u + ':'}); if (old.size) await this.state.storage.delete([...old.keys()]); }
    await this.state.storage.put('gs:' + u, g);
    const meta = await this.state.storage.list({prefix: 'm:'});
    await this.gQueue([...meta].filter(([, m]) => admin || m.owner === u).sort((a, b) => (a[1].started || a[1].at) - (b[1].started || b[1].at)).map(([k]) => k.slice(2)), 1000);
    return {title, url: g.url};
  }
  async gBatch(tok, base, requests) {
    const r = await fetch(base + ':batchUpdate', {method: 'POST', headers: {Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json'}, body: JSON.stringify({requests})});
    if (r.status === 404) { const e = new Error('gone'); e.gone = true; throw e; }
    const d = await r.json().catch(() => ({})); return {ok: r.ok, status: r.status, d};
  }
  /* a tab as a table with typed columns; if Google refuses tables, a plain tab with a coloured header row */
  async gTable(tok, g, base, key, sheetId, title, cols, addSheet) {
    const L = SHEET_TX[g.lang] || SHEET_TX.en;
    const hdr = cols.map(k => L.lang ? COLS[k][1] : COLS[k][0]), tableId = 't' + sheetId;
    const pre = addSheet ? [{addSheet: {properties: {sheetId, title, gridProperties: {frozenRowCount: 1}}}}] : [];
    const pi = cols.indexOf('pct');
    const look = [{updateDimensionProperties: {range: {sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: cols.length}, properties: {pixelSize: 120}, fields: 'pixelSize'}},
      ...cols.map((k, i) => ['q', 'picked', 'answer', 'topic'].includes(k) ? {updateDimensionProperties: {range: {sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1}, properties: {pixelSize: k === 'q' ? 320 : 190}, fields: 'pixelSize'}} : null).filter(Boolean),
      ...(pi >= 0 ? [{addConditionalFormatRule: {index: 0, rule: {ranges: [{sheetId, startRowIndex: 1, endRowIndex: 20000, startColumnIndex: pi, endColumnIndex: pi + 1}],
        gradientRule: {minpoint: {colorStyle: {rgbColor: {red: .96, green: .55, blue: .52}}, type: 'NUMBER', value: '0.3'}, midpoint: {colorStyle: {rgbColor: {red: 1, green: .87, blue: .55}}, type: 'NUMBER', value: '0.65'},
          maxpoint: {colorStyle: {rgbColor: {red: .55, green: .83, blue: .63}}, type: 'NUMBER', value: '0.95'}}}}}] : [])];
    const table = {addTable: {table: {name: tblName(title), tableId, range: {sheetId, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: cols.length},
      columnProperties: cols.map((k, i) => ({columnIndex: i, columnName: hdr[i], columnType: COLS[k][2]})),
      rowsProperties: {headerColorStyle: {rgbColor: {red: .17, green: .22, blue: .56}}, firstBandColorStyle: {rgbColor: {red: 1, green: 1, blue: 1}}, secondBandColorStyle: {rgbColor: {red: .96, green: .97, blue: .99}}}}}};
    let r = await this.gBatch(tok, base, [...pre, table, ...look]);
    if (!r.ok) { const t2 = JSON.parse(JSON.stringify(table)); delete t2.addTable.table.rowsProperties; r = await this.gBatch(tok, base, [...pre, t2, ...look]); }
    if (r.ok) { g.tabs[key] = {sheetId, tableId, title}; return; }
    /* fallback: a plain tab */
    if (pre.length) { const p = await this.gBatch(tok, base, pre); if (!p.ok && !/already exists/i.test(JSON.stringify(p.d))) throw new Error('addSheet'); }
    await fetch(`${base}/values/${encodeURIComponent(`'${title}'!A1`)}?valueInputOption=RAW`, {method: 'PUT', headers: {Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json'}, body: JSON.stringify({values: [hdr]})});
    await this.gBatch(tok, base, [{repeatCell: {range: {sheetId, startRowIndex: 0, endRowIndex: 1}, cell: {userEnteredFormat: {textFormat: {bold: true, foregroundColor: {red: 1, green: 1, blue: 1}}, backgroundColor: {red: .17, green: .22, blue: .56}}}, fields: 'userEnteredFormat(textFormat,backgroundColor)'}},
      {updateSheetProperties: {properties: {sheetId, gridProperties: {frozenRowCount: 1}}, fields: 'gridProperties.frozenRowCount'}},
      ...cols.map((k, i) => COLS[k][2] === 'DATE' || COLS[k][2] === 'PERCENT' ? {repeatCell: {range: {sheetId, startRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1}, cell: {userEnteredFormat: {numberFormat: COLS[k][2] === 'DATE' ? {type: 'DATE', pattern: 'dd.mm.yyyy'} : {type: 'PERCENT', pattern: '0%'}}}, fields: 'userEnteredFormat.numberFormat'}} : null).filter(Boolean), ...look]).catch(() => {});
    g.tabs[key] = {sheetId, tableId: null, title};
  }
  /* Overview: students, classes and the most missed questions, as live formulas over the tables */
  async gOverview(tok, g, base, L, LY) {
    const A = LY.all, M = LY.mis, ca = k => colLetter(A.indexOf(k)), cm = k => colLetter(M.indexOf(k)), O = L.ov, all = `'${L.tabs.all}'!A:${colLetter(A.length - 1)}`, mis = `'${L.tabs.mis}'!A:${colLetter(M.length - 1)}`;
    const h = k => (L.lang ? COLS[k][1] : COLS[k][0]);
    const q1 = `=IFERROR(QUERY(${all},"select ${ca('cls')}, ${ca('student')}, count(${ca('date')}), sum(${ca('right')}), sum(${ca('asked')}), sum(${ca('right')})/sum(${ca('asked')}) where ${ca('student')} is not null group by ${ca('cls')}, ${ca('student')} order by ${ca('cls')}, ${ca('student')} label ${ca('cls')} '${h('cls')}', ${ca('student')} '${h('student')}', count(${ca('date')}) '${O.results}', sum(${ca('right')}) '${h('right')}', sum(${ca('asked')}) '${h('asked')}', sum(${ca('right')})/sum(${ca('asked')}) '${h('pct')}' format sum(${ca('right')})/sum(${ca('asked')}) '0%'",1),"")`;
    const q2 = `=IFERROR(QUERY(${all},"select ${ca('cls')}, count(${ca('date')}), sum(${ca('right')})/sum(${ca('asked')}) where ${ca('cls')} is not null group by ${ca('cls')} order by ${ca('cls')} label ${ca('cls')} '${h('cls')}', count(${ca('date')}) '${O.results}', sum(${ca('right')})/sum(${ca('asked')}) '${h('pct')}' format sum(${ca('right')})/sum(${ca('asked')}) '0%'",1),"")`;
    const q3 = `=IFERROR(QUERY(${mis},"select ${cm('q')}, ${cm('answer')}, count(${cm('date')}) where ${cm('q')} is not null group by ${cm('q')}, ${cm('answer')} order by count(${cm('date')}) desc limit 25 label ${cm('q')} '${h('q')}', ${cm('answer')} '${h('answer')}', count(${cm('date')}) '${O.wrong}'",1),"")`;
    const val = x => typeof x === 'string' && x[0] === '=' ? {userEnteredValue: {formulaValue: x}} : {userEnteredValue: {stringValue: x}};
    const put = (r, c, list) => ({updateCells: {start: {sheetId: 0, rowIndex: r, columnIndex: c}, rows: list.map(row => ({values: row.map(val)})), fields: 'userEnteredValue'}});
    const bold = (r, c, size, color) => ({repeatCell: {range: {sheetId: 0, startRowIndex: r, endRowIndex: r + 1, startColumnIndex: c, endColumnIndex: c + 1}, cell: {userEnteredFormat: {textFormat: {bold: true, fontSize: size, foregroundColorStyle: {rgbColor: color || {red: .09, green: .13, blue: .24}}}}}, fields: 'userEnteredFormat.textFormat'}});
    const hrow = (c, n) => ({repeatCell: {range: {sheetId: 0, startRowIndex: 4, endRowIndex: 5, startColumnIndex: c, endColumnIndex: c + n}, cell: {userEnteredFormat: {textFormat: {bold: true, foregroundColorStyle: {rgbColor: {red: 1, green: 1, blue: 1}}}, backgroundColorStyle: {rgbColor: {red: .17, green: .22, blue: .56}}}}, fields: 'userEnteredFormat(textFormat,backgroundColorStyle)'}});
    const w = (c, px) => ({updateDimensionProperties: {range: {sheetId: 0, dimension: 'COLUMNS', startIndex: c, endIndex: c + 1}, properties: {pixelSize: px}, fields: 'pixelSize'}});
    const grad = (c) => ({addConditionalFormatRule: {index: 0, rule: {ranges: [{sheetId: 0, startRowIndex: 5, endRowIndex: 2000, startColumnIndex: c, endColumnIndex: c + 1}],
      gradientRule: {minpoint: {colorStyle: {rgbColor: {red: .96, green: .55, blue: .52}}, type: 'NUMBER', value: '0.3'}, midpoint: {colorStyle: {rgbColor: {red: 1, green: .87, blue: .55}}, type: 'NUMBER', value: '0.65'}, maxpoint: {colorStyle: {rgbColor: {red: .55, green: .83, blue: .63}}, type: 'NUMBER', value: '0.95'}}}}});
    await this.gBatch(tok, base, [put(0, 0, [[O.title], [O.note]]), put(3, 0, [[O.students]]), put(4, 0, [[q1]]), put(3, 7, [[O.classes]]), put(4, 7, [[q2]]), put(3, 11, [[O.missed]]), put(4, 11, [[q3]]),
      bold(0, 0, 18), bold(3, 0, 13), bold(3, 7, 13), bold(3, 11, 13), hrow(0, 6), hrow(7, 3), hrow(11, 3),
      {repeatCell: {range: {sheetId: 0, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 1}, cell: {userEnteredFormat: {textFormat: {foregroundColorStyle: {rgbColor: {red: .35, green: .38, blue: .54}}}}}, fields: 'userEnteredFormat.textFormat'}},
      w(0, 70), w(1, 150), w(2, 80), w(3, 80), w(4, 90), w(5, 90), w(6, 30), w(7, 70), w(8, 80), w(9, 90), w(10, 30), w(11, 360), w(12, 170), w(13, 70), grad(5), grad(9),
      {updateSheetProperties: {properties: {sheetId: 0, gridProperties: {frozenRowCount: 2}}, fields: 'gridProperties.frozenRowCount'}}]);
  }
  async alarm() {
    let q = (await this.state.storage.get('gq')) || []; if (!q.length) return;
    const accs = [...(await this.state.storage.list({prefix: 'acct:'})).values()], admins = accs.filter(a => a.role === 'admin').map(a => a.u);
    const conns = new Map(); for (const [k, g] of await this.state.storage.list({prefix: 'gs:'})) if (g && g.refresh) conns.set(k.slice(3), g);
    if (!conns.size) { await this.state.storage.put('gq', []); return; }
    /* sheets made before layout v2 get a fresh, clean sheet (the old one stays in the teacher's Drive) */
    for (const [u, g] of conns) if (g.v !== 2) {
      try { const acc = accs.find(a => a.u === u); if (acc) await this.gNewSheet(u, acc, g.lang || 'ro', await this.gToken(u, g), {refresh: g.refresh, email: g.email, old: g.url}); } catch (e) {}
      return this.state.storage.setAlarm(Date.now() + 2000);
    }
    const batch = q.slice(0, 40), rows = new Map(), marks = [];   // target -> tab key -> {name, list}
    for (const sid of batch) {
      const raw = await this.state.storage.get('s:' + sid); if (!raw) continue;
      let s; try { s = JSON.parse(raw); } catch (e) { continue; }
      const targets = [...new Set([s.owner, ...admins].filter(u => u && conns.has(u)))];
      for (const t of targets) {
        const g = conns.get(t), L = SHEET_TX[g.lang] || SHEET_TX.en, done = new Set((await this.state.storage.get(`gx:${t}:${sid}`)) || []), add = [];
        for (const rd of s.rounds || []) for (const res of rd.results || []) {
          const k = rd.id + '|' + res.player; if (done.has(k)) continue; add.push(k);
          const tabs = rows.get(t) || new Map(); rows.set(t, tabs);
          sheetRows(s, rd, res, accs, L).forEach(o => { const key = o.tab === 'cls' ? 'cls:' + o.name : o.tab; if (!tabs.has(key)) tabs.set(key, {name: o.name, kind: o.tab, list: []}); tabs.get(key).list.push(o.v); });
        }
        if (add.length) marks.push([`gx:${t}:${sid}`, [...done, ...add]]);
      }
    }
    const failed = new Set();
    for (const [t, tabs] of rows) {
      const g = conns.get(t);
      try { const tok = await this.gToken(t, g); for (const [key, x] of tabs) await this.gAppend(tok, g, key, x); g.at = Date.now(); g.err = null; }
      catch (e) { failed.add(t); g.err = e.fatal ? 'revoked' : e.gone ? 'deleted' : 'failed'; if (e.fatal || e.gone) g.refresh = null; }
      await this.state.storage.put('gs:' + t, g);
    }
    for (const [k, v] of marks) if (!failed.has(k.split(':')[1])) await this.state.storage.put(k, v);
    q = ((await this.state.storage.get('gq')) || []).filter(id => !batch.includes(id) || failed.size);
    await this.state.storage.put('gq', q);
    if (failed.size) { await this.state.storage.setAlarm(Date.now() + 10 * 60000); return; }
    if (q.length) await this.state.storage.setAlarm(Date.now() + 2000);
  }
  async gAppend(tok, g, key, x) {
    const base = (this.env.GOOGLE_TEST_URL || 'https://sheets.googleapis.com') + '/v4/spreadsheets/' + g.sheet, LY = LAYOUT(!!g.admin);
    const cols = x.kind === 'cls' ? LY.cls : LY[x.kind];
    if (!g.tabs[key]) { const id = g.next = (g.next || 10) + 1; await this.gTable(tok, g, base, key, id, x.name, cols, true); }
    const tb = g.tabs[key], rowsData = x.list.map(v => ({values: cols.map(k => cellOf(COLS[k][2], v[k]))}));
    if (tb.tableId) {
      const r = await this.gBatch(tok, base, [{appendCells: {tableId: tb.tableId, rows: rowsData, fields: 'userEnteredValue'}}]);
      if (r.ok) return;
      if (r.status === 404) { const e = new Error('gone'); e.gone = true; throw e; }
    }
    const r = await this.gBatch(tok, base, [{appendCells: {sheetId: tb.sheetId, rows: rowsData, fields: 'userEnteredValue'}}]);
    if (!r.ok) throw new Error('append ' + r.status);
  }
  /* ---------------- question sets ("My questions") ----------------
     set:<id> = {id, owner, ownerName, name, subject, classes:[ids], lang, shared, q:[[question, right, wrong, wrong, wrong?, image?]], at}
     GET  /sets -> {mine:[...], shared:[...]} (the admin's "mine" has everyone's)
     POST /sets {action:'save', set} -> {id}; {action:'delete', id}; {action:'copy', id} -> {id} */
  async sets(req, me) {
    const admin = me.role === 'admin', all = [...(await this.state.storage.list({prefix: 'set:'})).values()];
    if (req.method !== 'POST') {
      const mine = all.filter(x => x.owner === me.u || admin), shared = all.filter(x => x.shared && x.owner !== me.u && !admin);
      const by = (a, b) => (b.at || 0) - (a.at || 0);
      return this.json({mine: mine.sort(by), shared: shared.sort(by)});
    }
    const b = await this.body(req), clean = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
    if (b.action === 'save') {
      const x = b.set || {}, id = /^[a-z0-9]{6,16}$/.test(x.id || '') ? x.id : b64u(crypto.getRandomValues(new Uint8Array(9))).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'set' + Date.now().toString(36);
      const old = await this.state.storage.get('set:' + id);
      if (old && old.owner !== me.u && !admin) return this.json({error: 'Not your set'}, 403);
      const q = (Array.isArray(x.q) ? x.q : []).slice(0, 500).map(r => Array.isArray(r) ? [clean(r[0], 300), clean(r[1], 120), clean(r[2], 120), clean(r[3], 120), clean(r[4], 120), clean(r[5], 600)] : null)
        .filter(r => r && r[0] && r[1] && [r[2], r[3], r[4]].filter(Boolean).length >= 2).map(r => { while (r.length && !r[r.length - 1]) r.pop(); return r; });
      const name = clean(x.name, 80);
      if (!name) return this.json({error: 'name'}, 400);
      if (!q.length) return this.json({error: 'empty'}, 400);
      const rec = {id, owner: old ? old.owner : me.u, ownerName: old ? old.ownerName : me.name, name, subject: clean(x.subject, 40), classes: (Array.isArray(x.classes) ? x.classes : []).map(c => clean(c, 20)).filter(Boolean).slice(0, 40),
        lang: x.lang === 'ro' ? 'ro' : 'en', shared: !!x.shared, q, at: Date.now(), created: old ? old.created : Date.now()};
      if (JSON.stringify(rec).length > 400000) return this.json({error: 'Too big'}, 413);
      await this.state.storage.put('set:' + id, rec);
      return this.json({ok: true, id, set: rec});
    }
    const old = await this.state.storage.get('set:' + String(b.id || ''));
    if (!old) return this.json({error: 'missing'}, 404);
    if (b.action === 'delete') { if (old.owner !== me.u && !admin) return this.json({error: 'Not your set'}, 403); await this.state.storage.delete('set:' + old.id); return this.json({ok: true}); }
    if (b.action === 'copy') {
      if (!old.shared && old.owner !== me.u && !admin) return this.json({error: 'Not shared'}, 403);
      const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const rec = {...old, id, owner: me.u, ownerName: me.name, shared: false, copiedFrom: old.ownerName, at: Date.now(), created: Date.now()};
      await this.state.storage.put('set:' + id, rec);
      return this.json({ok: true, id, set: rec});
    }
    return this.json({error: 'Unknown action'}, 400);
  }
}
