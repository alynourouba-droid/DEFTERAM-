// Compteurs anonymes de DEFTERAM : visiteurs, visites, partages, vues par texte.
// Stockage : Upstash Redis, relié au projet depuis Vercel (Storage → Upstash for Redis).
// Aucune donnée personnelle : seulement des nombres.
//   GET  /api/stats                 → { visitors, visits, shares }
//   GET  /api/stats?id=p2           → … + item: { views, shares } du texte p2
//   GET  /api/stats?items=1         → … + views: {id:n}, ishares: {id:n} (tous les textes)
//   POST /api/stats?e=new|visit     → nouveau visiteur / nouvelle visite
//   POST /api/stats?e=share[&id=p2] → +1 partage (et +1 pour ce texte)
//   POST /api/stats?e=view&id=p2    → +1 vue pour ce texte
const K = { visitors: 'defteram:visitors', visits: 'defteram:visits', shares: 'defteram:shares', views: 'defteram:views', ishares: 'defteram:ishares' };

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
  return r.json();
}
const toMap = a => { const m = {}; for (let i = 0; a && i < a.length; i += 2) m[a[i]] = +a[i + 1] || 0; return m; };

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const c = cfg();
  if (!c) { res.statusCode = 503; return res.end(JSON.stringify({ error: 'not_configured' })); }
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  const id = q.id && /^[a-z0-9]{1,16}$/.test(q.id) ? q.id : null;
  if (q.id && !id) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'bad_id' })); }
  try {
    const cmds = [];
    if (req.method === 'POST') {
      const e = q.e;
      if (e === 'new') cmds.push(['INCR', K.visitors], ['INCR', K.visits]);
      else if (e === 'visit') cmds.push(['INCR', K.visits]);
      else if (e === 'share') { cmds.push(['INCR', K.shares]); if (id) cmds.push(['HINCRBY', K.ishares, id, 1]); }
      else if (e === 'view' && id) cmds.push(['HINCRBY', K.views, id, 1]);
      else { res.statusCode = 400; return res.end(JSON.stringify({ error: 'bad_event' })); }
    } else if (req.method !== 'GET') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'method' })); }
    const base = cmds.length;
    cmds.push(['MGET', K.visitors, K.visits, K.shares]);
    if (id) cmds.push(['HGET', K.views, id], ['HGET', K.ishares, id]);
    if (q.items) cmds.push(['HGETALL', K.views], ['HGETALL', K.ishares]);
    const out = await redis(c, cmds);
    const v = out[base].result || [];
    const body = { visitors: +v[0] || 0, visits: +v[1] || 0, shares: +v[2] || 0 };
    let k = base + 1;
    if (id) { body.item = { views: +out[k].result || 0, shares: +out[k + 1].result || 0 }; k += 2; }
    if (q.items) { body.views = toMap(out[k].result); body.ishares = toMap(out[k + 1].result); }
    res.statusCode = 200; res.end(JSON.stringify(body));
  } catch (err) { res.statusCode = 502; res.end(JSON.stringify({ error: 'storage' })); }
};
