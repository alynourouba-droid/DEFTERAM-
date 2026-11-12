// Outils partagés par les fonctions /api (ce fichier n'est pas une route : il commence par « _ »).
const crypto = require('crypto');
const P = 'defteram:';

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
// Jeton du stockage de fichiers Vercel Blob (BLOB_READ_WRITE_TOKEN, ou avec un préfixe personnalisé).
function blobToken() {
  const e = process.env;
  if (e.BLOB_READ_WRITE_TOKEN) return e.BLOB_READ_WRITE_TOKEN;
  const k = Object.keys(e).find(x => /_READ_WRITE_TOKEN$/.test(x) && /^vercel_blob_rw_/.test(e[x] || ''));
  return k ? e[k] : null;
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
async function readBody(req, max = 200000) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return null; } }
    if (Buffer.isBuffer(req.body)) { try { return JSON.parse(req.body.toString('utf8')); } catch (e) { return null; } }
    return req.body;
  }
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > max) return null; }
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { return null; }
}
// Renvoie l'identifiant du compte si le jeton de session est celui de l'administrateur.
async function adminFromToken(c, tk) {
  if (!tk || !/^[A-Za-z0-9_-]{20,100}$/.test(tk)) return null;
  const [id, admin] = await redis(c, [['GET', P + 'sess:' + sha(tk)], ['GET', P + 'admin']]);
  return id && id === admin ? id : null;
}
module.exports = { P, cfg, blobToken, redis, sha, readBody, adminFromToken };
