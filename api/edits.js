// Corrections des poèmes par les « correcteurs » (comptes choisis par l'administrateur).
// Les corrections sont gardées à part : le texte d'origine n'est jamais perdu et chaque correction peut être annulée.
//   GET  /api/edits?a=list                          → { map: { idDuTexte: { indexDuVers: [demi-vers…] } } }   (public)
//   GET  /api/edits?a=me                            → { editor, admin }
// Correcteur ou administrateur :
//   POST /api/edits?a=save   { item, idx, verse, old }  → corrige un vers
//   POST /api/edits?a=revert { item, idx }              → remet le vers d'origine
// Administrateur :
//   GET  /api/edits?a=editors · ?a=log
//   POST /api/edits?a=editor_add { user } · ?a=editor_del { user } · ?a=undo { i }
const { P, cfg, redis, sha, readBody } = require('./_lib');
const parse = x => { try { return x ? JSON.parse(x) : null; } catch (e) { return null; } };
const ID_RE = /^[a-z0-9._-]{3,30}$/, EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,80}\.[^\s@]{2,20}$/;

module.exports = async (req, res) => {
  const send = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(obj)); };
  const c = cfg();
  if (!c) return send(503, { error: 'not_configured' });
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  const a = q.a;
  try {
    if (a === 'list') {
      const [h] = await redis(c, [['HGETALL', P + 'edits']]);
      const map = {};
      for (let i = 0; h && i < h.length; i += 2) { const v = parse(h[i + 1]); if (v) map[h[i]] = v; }
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=20, stale-while-revalidate=120');
      return send(200, { map });
    }
    const hm = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization || '');
    if (!hm) return send(401, { error: 'not_signed_in' });
    const [me, admin] = await redis(c, [['GET', P + 'sess:' + sha(hm[1])], ['GET', P + 'admin']]);
    if (!me) return send(401, { error: 'not_signed_in' });
    const [isEd] = await redis(c, [['SISMEMBER', P + 'editors', me]]);
    const isAdmin = admin === me, editor = isAdmin || !!isEd;
    if (a === 'me') return send(200, { editor, admin: isAdmin });

    if (isAdmin && a === 'editors') { const [m] = await redis(c, [['SMEMBERS', P + 'editors']]); return send(200, { editors: (m || []).sort() }); }
    if (isAdmin && a === 'log') { const [l] = await redis(c, [['LRANGE', P + 'editlog', 0, 199]]); return send(200, { log: (l || []).map(parse).filter(Boolean) }); }

    if (req.method !== 'POST') return send(400, { error: 'bad_action' });
    const b = await readBody(req) || {};
    const item = String(b.item || ''), idx = parseInt(b.idx, 10);
    const okItem = /^[A-Za-z0-9_-]{1,40}$/.test(item) && idx >= 0 && idx < 5000;

    if (a === 'save' || a === 'revert') {
      if (!editor) return send(403, { error: 'not_editor' });
      if (!okItem) return send(400, { error: 'bad_item' });
      const [raw] = await redis(c, [['HGET', P + 'edits', item]]);
      const cur = parse(raw) || {};
      const before = cur[idx] || null;
      const entry = { i: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), item, idx, by: me, t: Date.now(), old: before || (Array.isArray(b.old) ? b.old.map(x => String(x).slice(0, 400)).slice(0, 4) : null), wasOrig: !before };
      if (a === 'save') {
        const v = (Array.isArray(b.verse) ? b.verse : []).map(x => String(x).replace(/\s+/g, ' ').trim().slice(0, 400)).filter((x, k, arr) => x || k < arr.length).slice(0, 4);
        if (!v.length || !v.some(Boolean)) return send(400, { error: 'empty' });
        cur[idx] = v; entry.new = v;
      } else { if (!before) return send(200, { ok: true }); delete cur[idx]; entry.new = null; entry.revert = true; }
      const cmds = Object.keys(cur).length ? [['HSET', P + 'edits', item, JSON.stringify(cur)]] : [['HDEL', P + 'edits', item]];
      cmds.push(['LPUSH', P + 'editlog', JSON.stringify(entry)], ['LTRIM', P + 'editlog', 0, 499]);
      await redis(c, cmds);
      return send(200, { ok: true, verse: cur[idx] || null });
    }

    if (!isAdmin) return send(403, { error: 'not_admin' });
    const u = String(b.user || '').trim().toLowerCase();
    if (a === 'editor_add') {
      if (!(ID_RE.test(u) || EMAIL_RE.test(u))) return send(400, { error: 'bad_id' });
      const [ex] = await redis(c, [['EXISTS', P + 'user:' + u]]);
      if (!ex) return send(404, { error: 'no_user' });
      await redis(c, [['SADD', P + 'editors', u]]);
      return send(200, { ok: true });
    }
    if (a === 'editor_del') { await redis(c, [['SREM', P + 'editors', u]]); return send(200, { ok: true }); }
    if (a === 'undo') {   // annule une correction de l'historique
      const [l] = await redis(c, [['LRANGE', P + 'editlog', 0, 499]]);
      const e = (l || []).map(parse).find(x => x && x.i === String(b.i || ''));
      if (!e) return send(404, { error: 'not_found' });
      const [raw] = await redis(c, [['HGET', P + 'edits', e.item]]);
      const cur = parse(raw) || {};
      if (e.wasOrig) delete cur[e.idx]; else if (e.old) cur[e.idx] = e.old;
      const entry = { i: Date.now().toString(36) + 'u', item: e.item, idx: e.idx, by: me, t: Date.now(), undo: e.i, new: cur[e.idx] || null };
      const cmds = Object.keys(cur).length ? [['HSET', P + 'edits', e.item, JSON.stringify(cur)]] : [['HDEL', P + 'edits', e.item]];
      cmds.push(['LPUSH', P + 'editlog', JSON.stringify(entry)], ['LTRIM', P + 'editlog', 0, 499]);
      await redis(c, cmds);
      return send(200, { ok: true });
    }
    return send(400, { error: 'bad_action' });
  } catch (err) {
    return send(502, { error: 'storage' });
  }
};
