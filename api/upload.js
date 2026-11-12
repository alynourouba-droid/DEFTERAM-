// Envoi de photos et d'audios vers Vercel Blob, directement depuis le navigateur de l'administrateur.
// Le navigateur demande ici un jeton d'envoi ; seul le compte administrateur l'obtient.
const { handleUpload } = require('@vercel/blob/client');
const { cfg, blobToken, readBody, adminFromToken } = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const send = (code, obj) => { res.statusCode = code; res.end(JSON.stringify(obj)); };
  const c = cfg(), token = blobToken();
  if (!c || !token) return send(503, { error: 'not_configured' });
  if (req.method !== 'POST') return send(405, { error: 'method' });
  const body = await readBody(req);
  if (!body) return send(400, { error: 'bad_request' });
  try {
    const json = await handleUpload({
      body, request: req, token,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const admin = await adminFromToken(c, clientPayload);
        if (!admin) throw new Error('not_admin');
        if (!/^guides\/[A-Za-z0-9._-]{1,120}$/.test(pathname)) throw new Error('bad_path');
        return {
          allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/wav', 'audio/x-m4a', 'audio/webm'],
          maximumSizeInBytes: 60 * 1024 * 1024,
          addRandomSuffix: true,
        };
      },
    });
    return send(200, json);
  } catch (err) {
    return send(err.message === 'not_admin' ? 403 : 400, { error: err.message === 'not_admin' ? 'not_admin' : 'upload_refused' });
  }
};
