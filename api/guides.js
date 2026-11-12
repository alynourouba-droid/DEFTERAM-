// Liste publique des guides (photos, audios, histoires), ajoutés par l'administrateur.
//   GET /api/guides → { guides: [ { id, name, role, story, photos:[url], audios:[{url,title}], t, order } ] }
const { P, cfg, redis } = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=30, stale-while-revalidate=300');
  const c = cfg();
  if (!c) { res.statusCode = 503; return res.end(JSON.stringify({ error: 'not_configured' })); }
  try {
    const [h] = await redis(c, [['HGETALL', P + 'guides']]);
    const guides = [];
    for (let i = 0; h && i < h.length; i += 2) { try { guides.push(JSON.parse(h[i + 1])); } catch (e) {} }
    guides.sort((a, b) => (a.order || 0) - (b.order || 0) || (a.t || 0) - (b.t || 0));
    res.statusCode = 200; res.end(JSON.stringify({ guides }));
  } catch (e) { res.statusCode = 502; res.end(JSON.stringify({ error: 'storage' })); }
};
