// Comptes DEFTERAM : inscription, connexion, déconnexion, sauvegarde des favoris.
// Stockage : la même base Upstash Redis que /api/stats (Vercel → Storage → Upstash for Redis).
// Aucun e-mail n'est envoyé. Les mots de passe sont stockés hachés (scrypt + sel).
//   GET  /api/auth?a=ping                       → { ok: true } si la base est reliée
//   POST /api/auth?a=signup  { id, password }   → { token, user }
//   POST /api/auth?a=login   { id, password }   → { token, user }
//   POST /api/auth?a=logout                     (Authorization: Bearer <token>)
//   GET  /api/auth?a=me                         → { user }
//   GET  /api/auth?a=data                       → { data }
//   POST /api/auth?a=data    { data }           → { ok: true }
const crypto = require('crypto');

const P = 'defteram:';
const SESSION_DAYS = 90;
const ID_RE = /^[a-z0-9._-]{3,30}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,80}\.[^\s@]{2,20}$/;

function cfg() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}
async function redis(c, commands) {
  const r = await fetch(c.url + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).map(x => x.result);
}
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const scrypt = (pw, salt) => new Promise((ok, no) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => e ? no(e) : ok(k)));
function publicUser(id) { const at = id.indexOf('@'); return at > -1 ? { name: id.slice(0, at), email: id } : { name: id }; }

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return null; } }
    if (Buffer.isBuffer(req.body)) { try { return JSON.parse(req.body.toString('utf8')); } catch (e) { return null; } }
    return req.body;
  }
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 600000) return null; }
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { return null; }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const send = (code, obj) => { res.statusCode = code; res.end(JSON.stringify(obj)); };
  const c = cfg();
  if (!c) return send(503, { error: 'not_configured' });
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  const a = q.a;
  try {
    if (a === 'ping') return send(200, { ok: true });

    async function newSession(id) {
      const tk = crypto.randomBytes(32).toString('base64url');
      await redis(c, [['SET', P + 'sess:' + sha(tk), id, 'EX', SESSION_DAYS * 86400]]);
      return { token: tk, user: publicUser(id) };
    }
    async function who() {
      const h = req.headers.authorization || req.headers.Authorization || '';
      const m = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(h);
      if (!m) return null;
      const [id] = await redis(c, [['GET', P + 'sess:' + sha(m[1])]]);
      return id ? { id, key: P + 'sess:' + sha(m[1]) } : null;
    }

    if ((a === 'signup' || a === 'login') && req.method === 'POST') {
      const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'x').split(',')[0].trim();
      const rk = P + 'rl:' + sha(ip).slice(0, 24) + ':' + Math.floor(Date.now() / 60000);
      const [n] = await redis(c, [['INCR', rk], ['EXPIRE', rk, 120]]);
      if (n > 20) return send(429, { error: 'rate_limit' });
      const b = await readBody(req);
      if (!b) return send(400, { error: 'bad_request' });
      const id = String(b.id || '').trim().toLowerCase();
      const pw = String(b.password || '');
      if (!(ID_RE.test(id) || EMAIL_RE.test(id))) return send(400, { error: 'bad_id' });
      if (pw.length < 6 || pw.length > 200) return send(400, { error: 'weak_password' });
      const uk = P + 'user:' + id;
      if (a === 'signup') {
        const salt = crypto.randomBytes(16);
        const hash = await scrypt(pw, salt);
        const rec = JSON.stringify({ s: salt.toString('base64'), h: hash.toString('base64'), t: Date.now() });
        const [ok] = await redis(c, [['SET', uk, rec, 'NX']]);
        if (ok !== 'OK') return send(409, { error: 'user_exists' });
        return send(200, await newSession(id));
      }
      const [raw] = await redis(c, [['GET', uk]]);
      if (!raw) { await scrypt(pw, crypto.randomBytes(16)); return send(401, { error: 'invalid_credentials' }); }
      const rec = JSON.parse(raw);
      const got = await scrypt(pw, Buffer.from(rec.s, 'base64'));
      const want = Buffer.from(rec.h, 'base64');
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return send(401, { error: 'invalid_credentials' });
      return send(200, await newSession(id));
    }

    const me = await who();
    if (!me) return send(401, { error: 'not_signed_in' });
    if (a === 'me') return send(200, { user: publicUser(me.id) });
    if (a === 'logout' && req.method === 'POST') { await redis(c, [['DEL', me.key]]); return send(200, { ok: true }); }
    if (a === 'data' && req.method === 'GET') {
      const [raw] = await redis(c, [['GET', P + 'data:' + me.id]]);
      return send(200, { data: raw ? JSON.parse(raw) : null });
    }
    if (a === 'data' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b || typeof b.data !== 'object' || b.data === null) return send(400, { error: 'bad_request' });
      const s = JSON.stringify(b.data);
      if (s.length > 500000) return send(413, { error: 'too_large' });
      await redis(c, [['SET', P + 'data:' + me.id, s]]);
      return send(200, { ok: true });
    }
    return send(400, { error: 'bad_action' });
  } catch (err) {
    return send(502, { error: 'storage' });
  }
};
