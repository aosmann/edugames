/* Create or reset a teacher account:  node add-teacher.mjs <username> "<Name>" [admin]
   Prints a new password once and saves only its hash in src/teachers.json (kept out of git).
   Then run: npx wrangler deploy */
process.removeAllListeners('warning');
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const {hashPassword, b64u} = await import('./src/auth.js');
const [u, name, role] = process.argv.slice(2);
if (!u || !/^[a-z0-9._-]{2,30}$/.test(u)) { console.log('Usage: node add-teacher.mjs <username> "<Name>" [admin]\n(username: lowercase letters, digits, . _ -)'); process.exit(1); }
const file = new URL('./src/teachers.json', import.meta.url);
const list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
const ABC = 'abcdefghjkmnpqrstuvwxyz23456789';
const pw = [...crypto.getRandomValues(new Uint8Array(10))].map(x => ABC[x % ABC.length]).join('').replace(/(.{5})/, '$1-');
const salt = b64u(crypto.getRandomValues(new Uint8Array(16)));
const rec = {u, name: name || u, role: role === 'admin' ? 'admin' : 'teacher', salt, iter: 100000, hash: await hashPassword(pw, salt)};
const i = list.findIndex(t => t.u === u); if (i >= 0) list[i] = rec; else list.push(rec);
fs.writeFileSync(file, JSON.stringify(list, null, 1));
console.log(`\n  ${i >= 0 ? 'Reset' : 'Created'}: ${rec.name} (${rec.role})\n  Username: ${u}\n  Password: ${pw}\n\n  Write it down now: it is not saved anywhere in plain text.\n  Then run: npx wrangler deploy\n`);
