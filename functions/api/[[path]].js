/* Fableroot cloud save API · Cloudflare Pages Functions + D1
   Bindings / variables (Pages → Settings):
     DB                D1 database (run schema.sql once)
     GOOGLE_CLIENT_ID  OAuth 2.0 Web client id from Google Cloud Console
   Routes:
     GET  /api/config            → { clientId }
     POST /api/auth/google       { credential }  → sets the session cookie
     POST /api/auth/logout
     GET  /api/me                → { user } | 401
     GET  /api/saves             → { saves:[{slot,t,updated,size,data}] }
     PUT  /api/saves/:slot       { data, dev, claim }   (claim:1 takes the slot over from another tab/device)
     DELETE /api/saves/:slot
*/
const COOKIE = 'fr_sess';
const SESSION_DAYS = 30;
const SLOTS = 3;
const MAX_SAVE = 1_000_000;          // bytes of JSON per slot
const MIN_GAP_MS = 5_000;            // one write per slot every 5 s at most
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const err = (status, code, msg) => json({ error: code, message: msg }, status);

const b64urlToBytes = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
const b64urlJson = s => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

/* ---------- Google ID token verification (RS256 against Google's published keys) ---------- */
let JWKS = null, JWKS_AT = 0;
async function googleKeys(env, force) {
  const url = env.GOOGLE_JWKS_URL || JWKS_URL;            // override exists only for local tests
  if (!force && JWKS && Date.now() - JWKS_AT < 3600_000) return JWKS;
  const r = await fetch(url, { cf: { cacheTtl: 3600 } });
  if (!r.ok) throw new Error('jwks ' + r.status);
  JWKS = (await r.json()).keys || []; JWKS_AT = Date.now();
  return JWKS;
}
async function verifyGoogle(token, env) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('bad token');
  const head = b64urlJson(parts[0]), body = b64urlJson(parts[1]);
  if (head.alg !== 'RS256') throw new Error('bad alg');
  let jwk = (await googleKeys(env)).find(k => k.kid === head.kid);
  if (!jwk) jwk = (await googleKeys(env, true)).find(k => k.kid === head.kid);   // keys rotate
  if (!jwk) throw new Error('unknown key');
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) throw new Error('bad signature');
  const now = Math.floor(Date.now() / 1000);
  if (body.iss !== 'accounts.google.com' && body.iss !== 'https://accounts.google.com') throw new Error('bad issuer');
  if (body.aud !== env.GOOGLE_CLIENT_ID) throw new Error('bad audience');
  if (!(body.exp > now - 60)) throw new Error('expired');
  if (!body.sub) throw new Error('no subject');
  return body;
}

/* ---------- sessions ---------- */
function readCookie(req, name) {
  const c = req.headers.get('cookie') || '';
  for (const p of c.split(';')) { const [k, ...v] = p.trim().split('='); if (k === name) return v.join('='); }
  return null;
}
function sessCookie(req, token, maxAge) {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
async function currentUser(req, env) {
  const tok = readCookie(req, COOKIE);
  if (!tok || !/^[0-9a-f]{64}$/.test(tok)) return null;
  const row = await env.DB.prepare('SELECT u.id,u.email,u.name,u.picture,s.expires FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?').bind(await sha256(tok)).first();
  if (!row || row.expires < Date.now()) return null;
  return row;
}

/* state-changing calls must come from this site (the cookie is SameSite=Lax; this closes the rest) */
function sameOrigin(req) {
  const o = req.headers.get('origin');
  if (!o) return true;                       // same-origin fetch from older browsers omits it on some methods
  return o === new URL(req.url).origin;
}

export async function onRequest(ctx) {
  const { request: req, env, params } = ctx;
  const path = '/' + [].concat(params.path || []).join('/');
  const m = req.method;
  try {
    if (!env.DB) return err(500, 'no_db', 'ยังไม่ได้ผูกฐานข้อมูล D1 ชื่อ DB');
    if (m !== 'GET' && !sameOrigin(req)) return err(403, 'origin', 'bad origin');

    if (path === '/config' && m === 'GET') return json({ clientId: env.GOOGLE_CLIENT_ID || null });

    if (path === '/auth/google' && m === 'POST') {
      if (!env.GOOGLE_CLIENT_ID) return err(500, 'no_client', 'ยังไม่ได้ตั้ง GOOGLE_CLIENT_ID');
      const { credential } = await req.json().catch(() => ({}));
      let g;
      try { g = await verifyGoogle(credential, env); } catch (e) { return err(401, 'bad_token', String(e.message || e)); }
      const now = Date.now();
      await env.DB.prepare('INSERT INTO users(sub,email,name,picture,created,last_login) VALUES(?,?,?,?,?,?) ON CONFLICT(sub) DO UPDATE SET email=excluded.email,name=excluded.name,picture=excluded.picture,last_login=excluded.last_login')
        .bind(g.sub, g.email || null, g.name || null, g.picture || null, now, now).run();
      const u = await env.DB.prepare('SELECT id,email,name,picture FROM users WHERE sub=?').bind(g.sub).first();
      const tok = hex(crypto.getRandomValues(new Uint8Array(32)));
      await env.DB.batch([
        env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND expires<?').bind(u.id, now),
        env.DB.prepare('INSERT INTO sessions(token_hash,user_id,created,expires) VALUES(?,?,?,?)').bind(await sha256(tok), u.id, now, now + SESSION_DAYS * 86400_000),
      ]);
      return json({ user: { email: u.email, name: u.name, picture: u.picture } }, 200, { 'set-cookie': sessCookie(req, tok, SESSION_DAYS * 86400) });
    }

    if (path === '/auth/logout' && m === 'POST') {
      const tok = readCookie(req, COOKIE);
      if (tok && /^[0-9a-f]{64}$/.test(tok)) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(tok)).run();
      return json({ ok: true }, 200, { 'set-cookie': sessCookie(req, '', 0) });
    }

    const user = await currentUser(req, env);
    if (!user) return err(401, 'login', 'ยังไม่ได้เข้าสู่ระบบ');

    if (path === '/me' && m === 'GET') return json({ user: { email: user.email, name: user.name, picture: user.picture } });

    if (path === '/saves' && m === 'GET') {
      const r = await env.DB.prepare('SELECT slot,t,updated,size,data FROM saves WHERE user_id=? ORDER BY slot').bind(user.id).all();
      return json({ saves: r.results || [] });
    }

    const sm = path.match(/^\/saves\/(\d)$/);
    if (sm) {
      const slot = +sm[1];
      if (slot < 1 || slot > SLOTS) return err(400, 'slot', 'bad slot');
      if (m === 'DELETE') {
        await env.DB.prepare('DELETE FROM saves WHERE user_id=? AND slot=?').bind(user.id, slot).run();
        return json({ ok: true });
      }
      if (m === 'PUT') {
        const raw = await req.text();
        if (raw.length > MAX_SAVE + 2000) return err(413, 'too_big', 'เซฟใหญ่เกินไป');
        let body; try { body = JSON.parse(raw); } catch { return err(400, 'json', 'bad json'); }
        const d = body && body.data, dev = String(body.dev || '').slice(0, 64);
        if (!d || typeof d !== 'object' || !Array.isArray(d.party) || !d.bag || !Array.isArray(d.bag.gear)) return err(400, 'shape', 'not a save');
        if (!dev) return err(400, 'dev', 'missing dev');
        const data = JSON.stringify(d);
        if (data.length > MAX_SAVE) return err(413, 'too_big', 'เซฟใหญ่เกินไป');
        const now = Date.now(), t = Math.min(Number(d.t) || now, now + 60_000);
        const cur = await env.DB.prepare('SELECT dev,updated FROM saves WHERE user_id=? AND slot=?').bind(user.id, slot).first();
        if (cur) {
          if (cur.dev && cur.dev !== dev && !body.claim) return err(409, 'taken', 'ช่องนี้กำลังเล่นอยู่บนอีกเครื่อง');
          if (cur.dev === dev && now - cur.updated < MIN_GAP_MS) return err(429, 'slow', 'บันทึกถี่เกินไป');
        }
        await env.DB.prepare('INSERT INTO saves(user_id,slot,data,t,updated,dev,size) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,slot) DO UPDATE SET data=excluded.data,t=excluded.t,updated=excluded.updated,dev=excluded.dev,size=excluded.size')
          .bind(user.id, slot, data, t, now, dev, data.length).run();
        return json({ ok: true, updated: now });
      }
    }
    return err(404, 'route', 'not found');
  } catch (e) {
    return err(500, 'server', String(e && e.message || e));
  }
}
