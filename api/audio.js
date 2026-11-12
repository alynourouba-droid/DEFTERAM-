// Audios des poèmes et des textes, ajoutés par l'administrateur depuis l'application.
// Les fichiers sont gardés dans la base Upstash, découpés en morceaux de 700 Ko (aucun service en plus).
//   GET  /api/audio?a=list                       → { map: { idDuTexte: { id, title, size, m, t } } }
//   GET  /api/audio?a=get&id=<id>                → le son (par morceaux : en-têtes Range acceptés)
// Administrateur (Authorization: Bearer <token>) :
//   POST /api/audio?a=begin  { item, mime, size, title } → { id }
//   POST /api/audio?a=chunk  { id, i, data }             (base64, 700 Ko max par morceau)
//   POST /api/audio?a=finish { id, item }                → l'audio remplace l'ancien
//   POST /api/audio?a=del    { item }
const crypto = require('crypto');
const { P, cfg, redis, readBody, adminFromToken } = require('./_lib');

const CHUNK = 700 * 1024;              // octets par morceau
const MAX = 15 * 1024 * 1024;          // 15 Mo par audio
const PART = 2 * 1024 * 1024;          // 2 Mo maximum par réponse (limite des fonctions Vercel : 4,5 Mo)
const MIME = /^audio\/(mpeg|mp3|mp4|x-m4a|m4a|aac|ogg|webm|wav|x-wav|3gpp|amr)(;[ a-z0-9=.,-]*)?$/i;
const parse = x => { try { return x ? JSON.parse(x) : null; } catch (e) { return null; } };

module.exports = async (req, res) => {
  const send = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(obj)); };
  const c = cfg();
  if (!c) return send(503, { error: 'not_configured' });
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  const a = q.a;
  try {
    if (a === 'list') {
      const [h] = await redis(c, [['HGETALL', P + 'audios']]);
      const map = {};
      for (let i = 0; h && i < h.length; i += 2) { const v = parse(h[i + 1]); if (v) map[h[i]] = { id: v.id, title: v.title || '', size: v.size, m: v.m, t: v.t }; }
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=20, stale-while-revalidate=120');
      res.statusCode = 200; res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ map }));
    }
    if (a === 'get') {
      const id = String(q.id || '');
      if (!/^[A-Za-z0-9_-]{16,40}$/.test(id)) return send(400, { error: 'bad_id' });
      const [raw] = await redis(c, [['GET', P + 'aum:' + id]]);
      const m = parse(raw);
      if (!m || !m.done) return send(404, { error: 'not_found' });
      const size = m.size;
      let start = 0, end = size - 1, partial = false;
      const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (r) {
        partial = true;
        if (r[1] === '') { start = Math.max(0, size - (+r[2] || 0)); }
        else { start = +r[1]; if (r[2] !== '') end = Math.min(+r[2], size - 1); }
        if (start >= size || start > end) { res.statusCode = 416; res.setHeader('Content-Range', 'bytes */' + size); return res.end(); }
      }
      if (end - start + 1 > PART) { end = start + PART - 1; partial = true; }
      const first = Math.floor(start / CHUNK), last = Math.floor(end / CHUNK);
      const keys = []; for (let i = first; i <= last; i++) keys.push(P + 'auc:' + id + ':' + i);
      const [vals] = await redis(c, [['MGET', ...keys]]);
      if (!vals || vals.some(v => !v)) return send(404, { error: 'not_found' });
      const buf = Buffer.concat(vals.map(v => Buffer.from(v, 'base64'))).subarray(start - first * CHUNK, end - first * CHUNK + 1);
      res.statusCode = partial ? 206 : 200;
      res.setHeader('Content-Type', m.m);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', buf.length);
      if (partial) res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + size);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.end(buf);
    }

    const hm = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization || '');
    const admin = hm ? await adminFromToken(c, hm[1]) : null;
    if (!admin) return send(403, { error: 'not_admin' });
    if (req.method !== 'POST') return send(400, { error: 'bad_action' });
    const b = await readBody(req, 1200000);
    if (b === null) return send(413, { error: 'too_large' });
    const item = String(b.item || '');
    const okItem = /^[A-Za-z0-9_-]{1,40}$/.test(item);

    if (a === 'begin') {
      const size = Math.round(+b.size), mime = String(b.mime || '');
      if (!okItem) return send(400, { error: 'bad_item' });
      if (!(size > 0 && size <= MAX)) return send(413, { error: 'too_large' });
      if (!MIME.test(mime)) return send(400, { error: 'bad_type' });
      const id = crypto.randomBytes(15).toString('base64url');
      const meta = { id, item, m: mime.split(';')[0].replace('audio/mp3', 'audio/mpeg'), size, n: Math.ceil(size / CHUNK), title: String(b.title || '').trim().slice(0, 120), t: Date.now(), done: false };
      await redis(c, [['SET', P + 'aum:' + id, JSON.stringify(meta), 'EX', 86400]]);
      return send(200, { id, chunk: CHUNK, n: meta.n });
    }
    const id = String(b.id || '');
    if (a === 'chunk' || a === 'finish') {
      if (!/^[A-Za-z0-9_-]{16,40}$/.test(id)) return send(400, { error: 'bad_id' });
      const [raw] = await redis(c, [['GET', P + 'aum:' + id]]);
      const m = parse(raw);
      if (!m || m.done) return send(404, { error: 'not_found' });
      if (a === 'chunk') {
        const i = +b.i, d = String(b.data || '');
        if (!(Number.isInteger(i) && i >= 0 && i < m.n)) return send(400, { error: 'bad_chunk' });
        if (!/^[A-Za-z0-9+/=]+$/.test(d) || d.length > Math.ceil(CHUNK / 3) * 4) return send(400, { error: 'bad_chunk' });
        await redis(c, [['SET', P + 'auc:' + id + ':' + i, d, 'EX', 86400]]);
        return send(200, { ok: true });
      }
      // finish : tous les morceaux sont là → l'audio devient permanent et remplace l'ancien
      const keys = []; for (let i = 0; i < m.n; i++) keys.push(P + 'auc:' + id + ':' + i);
      const r = await redis(c, keys.map(k => ['STRLEN', k]));
      const bytes = r.reduce((s, x) => s + Math.floor((x || 0) * 3 / 4), 0);
      if (r.some(x => !x)) return send(400, { error: 'missing_chunks' });
      if (Math.abs(bytes - m.size) > m.n * 3) return send(400, { error: 'bad_size' });
      m.done = true;
      const [old] = await redis(c, [['HGET', P + 'audios', m.item]]);
      const cmds = [['SET', P + 'aum:' + id, JSON.stringify(m)], ['HSET', P + 'audios', m.item, JSON.stringify(m)]].concat(keys.map(k => ['PERSIST', k]));
      const o = parse(old);
      if (o && o.id !== id) { cmds.push(['DEL', P + 'aum:' + o.id]); for (let i = 0; i < (o.n || 0); i++) cmds.push(['DEL', P + 'auc:' + o.id + ':' + i]); }
      await redis(c, cmds);
      return send(200, { ok: true, audio: { id, title: m.title, size: m.size, m: m.m, t: m.t } });
    }
    if (a === 'del') {
      if (!okItem) return send(400, { error: 'bad_item' });
      const [old] = await redis(c, [['HGET', P + 'audios', item]]);
      const o = parse(old), cmds = [['HDEL', P + 'audios', item]];
      if (o) { cmds.push(['DEL', P + 'aum:' + o.id]); for (let i = 0; i < (o.n || 0); i++) cmds.push(['DEL', P + 'auc:' + o.id + ':' + i]); }
      await redis(c, cmds);
      return send(200, { ok: true });
    }
    return send(400, { error: 'bad_action' });
  } catch (err) {
    return send(502, { error: 'storage' });
  }
};
