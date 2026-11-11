// Compteurs anonymes de DEFTERAM (visiteurs, visites, partages).
// Stockage : Upstash Redis, relié au projet depuis Vercel (Storage → Upstash for Redis).
// Aucune donnée personnelle : seulement trois nombres.
//   GET  /api/stats            → { visitors, visits, shares }
//   POST /api/stats?e=new      → nouveau visiteur (1re ouverture sur un appareil) + 1 visite
//   POST /api/stats?e=visit    → +1 visite
//   POST /api/stats?e=share    → +1 partage
const KEYS = { visitors: 'defteram:visitors', visits: 'defteram:visits', shares: 'defteram:shares' };
const EVENTS = { new: ['visitors', 'visits'], visit: ['visits'], share: ['shares'] };

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

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const c = cfg();
  if (!c) { res.statusCode = 503; return res.end(JSON.stringify({ error: 'not_configured' })); }
  try {
    const cmds = [];
    if (req.method === 'POST') {
      const e = (req.query && req.query.e) || new URL(req.url, 'http://x').searchParams.get('e');
      const add = EVENTS[e];
      if (!add) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'bad_event' })); }
      add.forEach(k => cmds.push(['INCR', KEYS[k]]));
    } else if (req.method !== 'GET') {
      res.statusCode = 405; return res.end(JSON.stringify({ error: 'method' }));
    }
    cmds.push(['MGET', KEYS.visitors, KEYS.visits, KEYS.shares]);
    const out = await redis(c, cmds);
    const v = (out[out.length - 1] && out[out.length - 1].result) || [];
    res.statusCode = 200;
    res.end(JSON.stringify({ visitors: +v[0] || 0, visits: +v[1] || 0, shares: +v[2] || 0 }));
  } catch (err) {
    res.statusCode = 502; res.end(JSON.stringify({ error: 'storage' }));
  }
};
