/* Teacher accounts: PBKDF2 password hashes and signed sign-in tokens (HMAC-SHA256).
   Works the same in Cloudflare Workers and Node 18+ (both have Web Crypto). */
const enc = new TextEncoder();
export const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const ub64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
export async function hashPassword(pw, salt, iter = 100000) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return b64u(await crypto.subtle.deriveBits({name: 'PBKDF2', hash: 'SHA-256', salt: ub64u(salt), iterations: iter}, key, 256));
}
const same = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
export async function checkPassword(t, pw) { return !!(t && t.salt && t.hash) && same(await hashPassword(String(pw || ''), t.salt, t.iter || 100000), t.hash); }
async function hmac(data, secret) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
export async function signToken(payload, secret) { const body = b64u(enc.encode(JSON.stringify(payload))); return body + '.' + await hmac(body, secret); }
export async function verifyToken(tok, secret) {
  if (!secret || typeof tok !== 'string' || !tok.includes('.')) return null;
  const [body, sig] = tok.split('.');
  if (!same(await hmac(body, secret), sig || '')) return null;
  let p; try { p = JSON.parse(new TextDecoder().decode(ub64u(body))); } catch (e) { return null; }
  return p && p.exp > Date.now() ? p : null;
}
export const bearer = req => { const h = req.headers.get ? req.headers.get('Authorization') : req.headers['authorization']; const m = /^Bearer (.+)$/.exec(h || ''); return m ? m[1] : ''; };
