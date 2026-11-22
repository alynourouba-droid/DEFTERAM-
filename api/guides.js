// Page « Nos guides » : liste publique des guides + j'aime, commentaires et histoires envoyées par les visiteurs.
//   GET  /api/guides                       → { guides: [ { id, name, role, story, photos:[url], audios:[{url,title}], t, order } ] }
//   GET  /api/guides?a=social&vid=<id>     → { likes, liked, comments: [ { i, name, text, t } ] }
//   POST /api/guides?a=like    { vid, on }            → { likes, liked }
//   POST /api/guides?a=comment { vid, name, text }    → { comments }
//   POST /api/guides?a=story   { name, contact, guide, text } → { ok }   (reçue par l'administrateur)
// Administrateur (Authorization: Bearer <token>) :
//   GET  /api/guides?a=stories             → { stories: [...] }
//   POST /api/guides?a=del_story { t }     ·   POST /api/guides?a=del_comment { t }
const { P, cfg, redis, sha, readBody, adminFromToken } = require('./_lib');

const parse = x => { try { return JSON.parse(x); } catch (e) { return null; } };
const clean = (x, n) => String(x == null ? '' : x).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, n);

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const send = (code, obj, cache) => { res.statusCode = code; res.setHeader('Cache-Control', cache || 'no-store'); res.end(JSON.stringify(obj)); };
  const c = cfg();
  if (!c) return send(503, { error: 'not_configured' });
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  const a = q.a || '';
  const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'x').split(',')[0].trim();
  async function limited(tag, max) {
    const rk = P + 'rl:' + tag + ':' + sha(ip).slice(0, 24) + ':' + Math.floor(Date.now() / 60000);
    const [n] = await redis(c, [['INCR', rk], ['EXPIRE', rk, 120]]);
    return n > max;
  }
  const okVid = v => /^[A-Za-z0-9_-]{8,40}$/.test(v || '');
  async function comments() {
    const [list] = await redis(c, [['LRANGE', P + 'gcomments', 0, 199]]);
    return (list || []).map(parse).filter(Boolean).map(x => ({ name: x.name, text: x.text, t: x.t }));
  }
  try {
    if (!a) {
      const [h] = await redis(c, [['HGETALL', P + 'guides']]);
      const guides = [];
      for (let i = 0; h && i < h.length; i += 2) { const g = parse(h[i + 1]); if (g) guides.push(g); }
      guides.sort((x, y) => (x.order || 0) - (y.order || 0) || (x.t || 0) - (y.t || 0));
      return send(200, { guides }, 'public, max-age=0, s-maxage=30, stale-while-revalidate=300');
    }
    if (a === 'social') {
      const vid = String(q.vid || '');
      const [likes, liked] = await redis(c, [['SCARD', P + 'glikes'], ['SISMEMBER', P + 'glikes', okVid(vid) ? vid : '-']]);
      return send(200, { likes: +likes || 0, liked: !!+liked, comments: await comments() });
    }
    if (req.method === 'POST' && (a === 'like' || a === 'comment' || a === 'story')) {
      const b = await readBody(req, 20000);
      if (!b) return send(400, { error: 'bad_request' });
      if (a === 'like') {
        const vid = String(b.vid || '');
        if (!okVid(vid)) return send(400, { error: 'bad_vid' });
        if (await limited('glike', 30)) return send(429, { error: 'rate_limit' });
        const [, n] = await redis(c, [[b.on ? 'SADD' : 'SREM', P + 'glikes', vid], ['SCARD', P + 'glikes']]);
        return send(200, { likes: +n || 0, liked: !!b.on });
      }
      if (a === 'comment') {
        const name = clean(b.name, 40) || 'Anonyme', text = clean(b.text, 600);
        if (text.length < 2) return send(400, { error: 'empty' });
        if (await limited('gcomment', 4)) return send(429, { error: 'rate_limit' });
        await redis(c, [['LPUSH', P + 'gcomments', JSON.stringify({ name, text, t: Date.now() })], ['LTRIM', P + 'gcomments', 0, 499]]);
        return send(200, { comments: await comments() });
      }
      // a === 'story'
      const name = clean(b.name, 60), contact = clean(b.contact, 80), guide = clean(b.guide, 80), text = clean(b.text, 8000);
      if (!name || text.length < 10) return send(400, { error: 'empty' });
      if (await limited('gstory', 3)) return send(429, { error: 'rate_limit' });
      await redis(c, [['LPUSH', P + 'gstories', JSON.stringify({ name, contact, guide, text, t: Date.now() })], ['LTRIM', P + 'gstories', 0, 499], ['INCR', P + 'gstories_new']]);
      return send(200, { ok: true });
    }
    // ---- administrateur ----
    const hm = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization || '');
    const admin = hm ? await adminFromToken(c, hm[1]) : null;
    if (!admin) return send(403, { error: 'not_admin' });
    if (a === 'stories') {
      const [list] = await redis(c, [['LRANGE', P + 'gstories', 0, 499], ['SET', P + 'gstories_new', 0]]);
      return send(200, { stories: (list || []).map(parse).filter(Boolean) });
    }
    if ((a === 'del_story' || a === 'del_comment') && req.method === 'POST') {
      const b = await readBody(req, 2000);
      const key = P + (a === 'del_story' ? 'gstories' : 'gcomments'), t = +(b && b.t);
      const [list] = await redis(c, [['LRANGE', key, 0, 499]]);
      const raw = (list || []).find(x => { const v = parse(x); return v && v.t === t; });
      if (raw) await redis(c, [['LREM', key, 1, raw]]);
      return send(200, { ok: !!raw });
    }
    return send(400, { error: 'bad_action' });
  } catch (e) { return send(502, { error: 'storage' }); }
};
