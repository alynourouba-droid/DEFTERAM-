// Espace administrateur DEFTERAM + messages des visiteurs.
// Même base Upstash Redis que /api/auth et /api/stats.
//
// Public :
//   POST /api/admin?a=msg  { stars, text, lang, name }  → enregistre un message / une note
// Compte connecté (Authorization: Bearer <token>) :
//   POST /api/admin?a=claim { code }   → devient administrateur (une seule fois, code secret)
// Administrateur seulement :
//   GET  /api/admin?a=overview         → totaux, nombre de comptes, de messages
//   GET  /api/admin?a=items            → vues et partages de chaque texte
//   POST /api/admin?a=reset_item { id } / ?a=reset_all
//   GET  /api/admin?a=users            → liste des comptes
//   POST /api/admin?a=del_user { id }  / ?a=set_password { id, password }
//   GET  /api/admin?a=msgs             → messages reçus (les plus récents d'abord)
//   POST /api/admin?a=del_msg { i } / ?a=read_msgs
const crypto = require('crypto');
const P = 'defteram:';
// Empreinte SHA-256 du code secret d'administration (le code lui-même n'est pas dans le code source).
const CLAIM_HASH = '75fb5d14b1fb4fc24d8fc2286c868f3edc5fdff3c6d2a02cd68b7e30bee3c628';

function cfg() {
  const e = process.env;
  let url = e.KV_REST_API_URL || e.UPSTASH_REDIS_REST_URL, token = e.KV_REST_API_TOKEN || e.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    for (const k of Object.keys(e)) {
      const m = /^(.*)_REST_API_URL$/.exec(k) || /^(.*)_REDIS_REST_URL$/.exec(k);
      if (!m) continue;
      const t = e[m[1] + '_REST_API_TOKEN'] || e[m[1] + '_REDIS_REST_TOKEN'];
      if (e[k] && t) { url = e[k]; token = t; break; }
    }
  }
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
const toMap = a => { const m = {}; for (let i = 0; a && i < a.length; i += 2) m[a[i]] = +a[i + 1] || 0; return m; };
async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return null; } }
    if (Buffer.isBuffer(req.body)) { try { return JSON.parse(req.body.toString('utf8')); } catch (e) { return null; } }
    return req.body;
  }
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 100000) return null; }
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { return null; }
}
async function scanKeys(c, pattern) {
  let cur = '0'; const keys = [];
  for (let n = 0; n < 50; n++) {
    const [r] = await redis(c, [['SCAN', cur, 'MATCH', pattern, 'COUNT', 500]]);
    cur = String(r[0]); keys.push(...r[1]);
    if (cur === '0') break;
  }
  return keys;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const send = (code, obj) => { res.statusCode = code; res.end(JSON.stringify(obj)); };
  const c = cfg();
  if (!c) return send(503, { error: 'not_configured' });
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  const a = q.a;
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'x').split(',')[0].trim();
  async function limited(tag, max) {
    const rk = P + 'rl:' + tag + ':' + sha(ip).slice(0, 24) + ':' + Math.floor(Date.now() / 60000);
    const [n] = await redis(c, [['INCR', rk], ['EXPIRE', rk, 120]]);
    return n > max;
  }
  try {
    // ---- message public ----
    if (a === 'msg' && req.method === 'POST') {
      if (await limited('msg', 5)) return send(429, { error: 'rate_limit' });
      const b = await readBody(req);
      if (!b) return send(400, { error: 'bad_request' });
      const stars = Math.max(0, Math.min(5, parseInt(b.stars, 10) || 0));
      const text = String(b.text || '').slice(0, 2000).trim();
      if (!stars && !text) return send(400, { error: 'empty' });
      let user = null;
      const h = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization || '');
      if (h) { const [id] = await redis(c, [['GET', P + 'sess:' + sha(h[1])]]); user = id || null; }
      const m = { t: Date.now(), stars, text, lang: String(b.lang || '').slice(0, 5), name: String(b.name || '').slice(0, 40), user };
      await redis(c, [['LPUSH', P + 'msgs', JSON.stringify(m)], ['LTRIM', P + 'msgs', 0, 999], ['INCR', P + 'msgs_unread']]);
      return send(200, { ok: true });
    }

    // ---- compte connecté ----
    const hm = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization || '');
    if (!hm) return send(401, { error: 'not_signed_in' });
    const [me, admin] = await redis(c, [['GET', P + 'sess:' + sha(hm[1])], ['GET', P + 'admin']]);
    if (!me) return send(401, { error: 'not_signed_in' });

    if (a === 'claim' && req.method === 'POST') {
      if (await limited('claim', 5)) return send(429, { error: 'rate_limit' });
      const b = await readBody(req) || {};
      const code = String(b.code || '').trim().toUpperCase();
      if (sha(code) !== CLAIM_HASH) return send(403, { error: 'bad_code' });
      const [ok] = await redis(c, [['SET', P + 'admin', me, 'NX']]);
      if (ok !== 'OK') { const [cur] = await redis(c, [['GET', P + 'admin']]); return cur === me ? send(200, { ok: true }) : send(409, { error: 'admin_exists' }); }
      return send(200, { ok: true });
    }
    if (admin !== me) return send(403, { error: 'not_admin' });

    if (a === 'overview') {
      const users = await scanKeys(c, P + 'user:*');
      const r = await redis(c, [['MGET', P + 'visitors', P + 'visits', P + 'shares'], ['LLEN', P + 'msgs'], ['GET', P + 'msgs_unread']]);
      const v = r[0] || [];
      return send(200, { visitors: +v[0] || 0, visits: +v[1] || 0, shares: +v[2] || 0, users: users.length, msgs: +r[1] || 0, unread: +r[2] || 0, admin: me });
    }
    if (a === 'items') {
      const [views, sh] = await redis(c, [['HGETALL', P + 'views'], ['HGETALL', P + 'ishares']]);
      return send(200, { views: toMap(views), ishares: toMap(sh) });
    }
    if (a === 'users') {
      const keys = await scanKeys(c, P + 'user:*');
      const vals = keys.length ? await redis(c, keys.map(k => ['GET', k])) : [];
      const users = keys.map((k, i) => { let t = 0; try { t = JSON.parse(vals[i]).t || 0; } catch (e) {} return { id: k.slice((P + 'user:').length), t }; })
        .sort((x, y) => y.t - x.t);
      return send(200, { users });
    }
    if (a === 'msgs') {
      const [list] = await redis(c, [['LRANGE', P + 'msgs', 0, 999]]);
      return send(200, { msgs: (list || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean) });
    }
    if (req.method !== 'POST') return send(400, { error: 'bad_action' });
    const b = await readBody(req) || {};
    if (a === 'read_msgs') { await redis(c, [['SET', P + 'msgs_unread', 0]]); return send(200, { ok: true }); }
    if (a === 'del_msg') {
      const i = parseInt(b.i, 10);
      if (!(i >= 0)) return send(400, { error: 'bad_request' });
      const mark = '__deleted__' + crypto.randomBytes(6).toString('hex');
      await redis(c, [['LSET', P + 'msgs', i, mark], ['LREM', P + 'msgs', 1, mark]]);
      return send(200, { ok: true });
    }
    if (a === 'reset_item') {
      const id = String(b.id || '');
      if (!/^[a-z0-9]{1,16}$/.test(id)) return send(400, { error: 'bad_id' });
      await redis(c, [['HDEL', P + 'views', id], ['HDEL', P + 'ishares', id]]);
      return send(200, { ok: true });
    }
    if (a === 'reset_all') {
      await redis(c, [['DEL', P + 'views', P + 'ishares', P + 'visitors', P + 'visits', P + 'shares']]);
      return send(200, { ok: true });
    }
    const id = String(b.id || '').toLowerCase();
    if (!/^[^\s]{3,120}$/.test(id)) return send(400, { error: 'bad_id' });
    if (a === 'del_user') {
      if (id === me) return send(400, { error: 'cannot_delete_self' });
      const [sess] = await redis(c, [['SMEMBERS', P + 'usess:' + id]]);
      const cmds = [['DEL', P + 'user:' + id, P + 'data:' + id, P + 'usess:' + id]];
      (sess || []).forEach(h => cmds.push(['DEL', P + 'sess:' + h]));
      await redis(c, cmds);
      return send(200, { ok: true });
    }
    if (a === 'set_password') {
      const pw = String(b.password || '');
      if (pw.length < 6 || pw.length > 200) return send(400, { error: 'weak_password' });
      const [raw, sess] = await redis(c, [['GET', P + 'user:' + id], ['SMEMBERS', P + 'usess:' + id]]);
      if (!raw) return send(404, { error: 'no_user' });
      const rec = JSON.parse(raw); const salt = crypto.randomBytes(16);
      rec.s = salt.toString('base64'); rec.h = (await scrypt(pw, salt)).toString('base64');
      const cmds = [['SET', P + 'user:' + id, JSON.stringify(rec)], ['DEL', P + 'usess:' + id]];
      (sess || []).forEach(h => cmds.push(['DEL', P + 'sess:' + h]));
      await redis(c, cmds);
      return send(200, { ok: true });
    }
    return send(400, { error: 'bad_action' });
  } catch (err) {
    return send(502, { error: 'storage' });
  }
};
