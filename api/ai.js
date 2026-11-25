// Atelier IA de DEFTERAM : l'administrateur seul demande à Claude d'écrire un poème ou un autre texte.
// POST /api/ai  (Authorization: Bearer <token de session de l'administrateur>)
//   { kind, lang, topic, length, style, notes }  →  { title, text }
// Nécessite la variable d'environnement ANTHROPIC_API_KEY sur Vercel.
const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
const { P, cfg, redis, sha, readBody } = require('./_lib');

const KINDS = {
  poeme: 'un poème (qasida) en l’honneur du Prophète ﷺ, d’Allah ou d’un guide, en vers bien rythmés',
  madh: 'un poème de louange du Prophète ﷺ (madh)',
  douaa: 'une prière (douʿâ) et des invocations',
  tawassul: 'un poème de tawassul (intercession)',
  histoire: 'un court récit / une histoire édifiante',
  khutba: 'un sermon (khutba) court',
  explication: 'une explication simple (charh) du texte donné dans les notes',
  traduction: 'une traduction fidèle du texte donné dans les notes',
};
const LANGS = { ar: 'arabe classique, avec les voyelles (harakat)', fr: 'français', ff: 'pulaar (fulfulde du Fouta), en écriture latine', wo: 'wolof, en écriture latine', en: 'anglais' };
const LENGTHS = { court: 'court (environ 6 à 8 vers ou 120 mots)', moyen: 'moyen (environ 12 à 16 vers ou 250 mots)', long: 'long (environ 24 à 30 vers ou 450 mots)' };

const SYSTEM = `Tu es l'atelier d'écriture de DEFTERAM, une bibliothèque islamique (tradition soufie Tijaniyya, Sénégal, Fass Gounass).
Tu écris des textes religieux respectueux, conformes à la croyance sunnite (achʿarite, malikite) : pas d'innovation blâmable, pas d'exagération contraire à l'unicité d'Allah, pas de hadith inventé.
N'attribue jamais un texte à un savant réel : c'est un texte nouveau proposé à l'administrateur, qui le relira.
Pour la poésie arabe, garde un mètre (bahr) régulier et une rime unique (qâfiya) ; écris chaque vers sur une ligne, avec les deux hémistiches séparés par « ⁂ ».
Pour les autres langues, écris un vers par ligne.
Réponds uniquement avec le titre sur la première ligne, précédé de « # », puis une ligne vide, puis le texte. Pas d'autre commentaire.`;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const send = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); };
  if (req.method !== 'POST') return send(405, { error: 'method' });
  const c = cfg();
  if (!c) return send(503, { error: 'not_configured' });
  try {
    const hm = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization || '');
    if (!hm) return send(401, { error: 'not_signed_in' });
    const [me, admin] = await redis(c, [['GET', P + 'sess:' + sha(hm[1])], ['GET', P + 'admin']]);
    if (!me) return send(401, { error: 'not_signed_in' });
    if (admin !== me) return send(403, { error: 'not_admin' });
    if (!process.env.ANTHROPIC_API_KEY) return send(503, { error: 'no_api_key' });
    const rk = P + 'rl:ai:' + Math.floor(Date.now() / 3600000);
    const [n] = await redis(c, [['INCR', rk], ['EXPIRE', rk, 7200]]);
    if (n > 30) return send(429, { error: 'rate_limit' });

    const b = await readBody(req) || {};
    const kind = KINDS[b.kind] ? b.kind : 'poeme', lang = LANGS[b.lang] ? b.lang : 'ar', len = LENGTHS[b.length] ? b.length : 'moyen';
    const clean = (s, m) => String(s || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, m);
    const topic = clean(b.topic, 300), style = clean(b.style, 200), notes = clean(b.notes, 4000);
    if (!topic && !notes) return send(400, { error: 'empty' });
    const ask = `Écris ${KINDS[kind]}, en ${LANGS[lang]}, de longueur ${LENGTHS[len]}.
Sujet : ${topic || '(voir les notes)'}
${style ? 'Style ou modèle souhaité : ' + style + '\n' : ''}${notes ? 'Notes / texte de départ de l’administrateur :\n<notes>\n' + notes + '\n</notes>\n' : ''}`;

    const client = new Anthropic();
    const msg = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      system: SYSTEM,
      messages: [{ role: 'user', content: ask }],
    });
    if (msg.stop_reason === 'refusal') return send(422, { error: 'refusal' });
    const out = msg.content.filter(x => x.type === 'text').map(x => x.text).join('').trim();
    const m = /^#\s*(.+)\n+([\s\S]*)$/.exec(out);
    return send(200, { title: m ? m[1].trim() : (topic || 'Texte'), text: m ? m[2].trim() : out, kind, lang, truncated: msg.stop_reason === 'max_tokens' });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return send(503, { error: 'bad_api_key' });
    if (e instanceof Anthropic.RateLimitError) return send(429, { error: 'ai_busy' });
    if (e instanceof Anthropic.APIError) return send(502, { error: 'ai_error', status: e.status });
    return send(502, { error: 'storage' });
  }
};
module.exports.config = { maxDuration: 120 };
