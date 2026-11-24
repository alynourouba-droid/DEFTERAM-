// École en ligne DEFTERAM « Ar Jangou » — un seul enseignant : l'administrateur.
// Les élèves s'inscrivent (Coran, Charia : Al-Akhdari, Al-Muqaddima, Ar-Risâla, woudou, ghousl) ; l'enseignant accepte ou refuse.
// Le 1er mois est gratuit ; ensuite l'élève paie le prix fixé par l'enseignant, qui confirme le paiement reçu (+1 mois).
// Public :
//   GET  /api/ecole?a=info                  → profil de l'enseignant, horaires, matières
// Compte connecté (Authorization: Bearer <token>) :
//   GET  /api/ecole?a=moi                   → mon inscription ; si acceptée : cours, leçons, devoirs, annonces, messages, cours en direct
//   POST /api/ecole?a=inscrire              { name, phone, age, subj:[…], level, slot, msg }
//   POST /api/ecole?a=msg                   { text }   → message à l'enseignant
//   POST /api/ecole?a=paye                  { method, phone, ref } → après le 1er mois gratuit, l'élève a payé (Wave / Orange Money)
//   (enseignant) POST ?a=payok | payno { user } → paiement reçu : +1 mois / pas reçu
// Enseignant (administrateur) :
//   GET  /api/ecole?a=eleves                → demandes et élèves, cours, leçons, devoirs, annonces, direct
//   GET  /api/ecole?a=fil&user=<id>         → messages avec un élève
//   POST /api/ecole?a=statut  { user, s: 'a' | 'r' | 'x' }      (accepter, refuser, retirer)
//   POST /api/ecole?a=amsg    { user, text }
//   POST /api/ecole?a=profil  { name, bio, sched, photo }
//   POST /api/ecole?a=add     { k: 'cours' | 'lecons' | 'devoirs' | 'ann', item }   ·   POST /api/ecole?a=del { k, id }
//   POST /api/ecole?a=live    { on }
const crypto = require('crypto');
const { P, cfg, redis, sha, readBody } = require('./_lib');

const SUBJ = [
  { id: 'quran', g: 'coran', icon: '📖', fr: 'Le Saint Coran', ar: 'القرآن الكريم', d: 'Lecture, tajwid et mémorisation' },
  { id: 'akhdari', g: 'charia', icon: '📗', fr: 'Al-Akhdari', ar: 'الأخضري', d: 'La purification et la prière' },
  { id: 'muqaddima', g: 'charia', icon: '📘', fr: 'Al-Muqaddima', ar: 'المقدّمة', d: 'Les bases de la religion' },
  { id: 'risala', g: 'charia', icon: '📙', fr: 'Ar-Risâla', ar: 'الرسالة', d: 'Le fiqh malikite d’Ibn Abî Zayd' },
  { id: 'woudou', g: 'charia', icon: '💧', fr: 'Apprendre le woudou', ar: 'الوضوء', d: 'Les ablutions pas à pas' },
  { id: 'ghousl', g: 'charia', icon: '🚿', fr: 'Al-Ghousl', ar: 'الغسل', d: 'Le grand lavage rituel' },
];
const SIDS = SUBJ.map(s => s.id);
const LEVELS = ['debutant', 'moyen', 'avance'];
const SLOTS = ['soir', 'matin', 'weekend'];
const KINDS = { cours: 60, lecons: 200, devoirs: 100, ann: 50 };
const DEF = { name: 'Oustaz', bio: 'Enseignant de l’école en ligne DEFTERAM.', sched: 'Lun–Ven 20h–22h · Sam–Dim 8h–10h', photo: '', price: 0, wave: '', om: '' };
const MONTH = 30 * 86400000;
const parse = s => { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } };
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const cleanML = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, n);
const nameOf = id => { const at = id.indexOf('@'); return at > -1 ? id.slice(0, at) : id; };
const isUrl = u => typeof u === 'string' && (/^img\/[A-Za-z0-9._-]{1,80}$/.test(u) || /^https:\/\/[a-z0-9.-]+\.public\.blob\.vercel-storage\.com\/[^\s"'<>]{1,300}$/.test(u));
const isLink = u => typeof u === 'string' && /^https:\/\/[^\s"'<>]{4,400}$/.test(u);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const send = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); };
  const c = cfg();
  if (!c) return send(503, { error: 'not_configured' });
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  const a = q.a;
  try {
    const [praw] = await redis(c, [['GET', P + 'ecole']]);
    const prof = Object.assign({}, DEF, parse(praw) || {});
    if (a === 'info') return send(200, { prof, subjects: SUBJ, levels: LEVELS, slots: SLOTS });

    const hm = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization || '');
    if (!hm) return send(401, { error: 'not_signed_in' });
    const [me, admin] = await redis(c, [['GET', P + 'sess:' + sha(hm[1])], ['GET', P + 'admin']]);
    if (!me) return send(401, { error: 'not_signed_in' });
    const isAdmin = admin === me;
    async function limited(kind, max) {
      const k = P + 'rl:e' + kind + ':' + sha(me).slice(0, 16) + ':' + Math.floor(Date.now() / 60000);
      const [n] = await redis(c, [['INCR', k], ['EXPIRE', k, 120]]);
      return n > max;
    }
    async function lists() {
      const r = await redis(c, Object.keys(KINDS).map(k => ['LRANGE', P + 'e' + k, 0, -1]).concat([['GET', P + 'elive']]));
      const o = {}; Object.keys(KINDS).forEach((k, i) => { o[k] = (r[i] || []).map(parse).filter(Boolean); });
      o.live = parse(r[r.length - 1]); return o;
    }
    async function fil(u) {
      const [m] = await redis(c, [['LRANGE', P + 'emsg:' + u, -200, -1]]);
      return (m || []).map(parse).filter(Boolean);
    }
    async function push(u, from, text) {
      const m = JSON.stringify({ f: from, x: text, t: Date.now() });
      await redis(c, [['RPUSH', P + 'emsg:' + u, m], ['LTRIM', P + 'emsg:' + u, -300, -1], ['HINCRBY', P + (from === 's' ? 'eun' : 'eus'), u, 1]]);
    }

    if (a === 'moi') {
      const [raw, us] = await redis(c, [['HGET', P + 'eins', me], ['HGET', P + 'eus', me]]);
      const ins = parse(raw);
      const out = { user: nameOf(me), admin: isAdmin, ins: ins ? { s: ins.s, name: ins.name, phone: ins.phone, age: ins.age, subj: ins.subj, level: ins.level, slot: ins.slot, msg: ins.msg, t: ins.t, until: ins.until || 0, paid: !!ins.paid, pay: ins.pay || null } : null };
      if (isAdmin) { const [un, all] = await redis(c, [['HVALS', P + 'eun'], ['HVALS', P + 'eins']]);
        out.adm = { unread: (un || []).reduce((n, v) => n + (+v || 0), 0), pending: (all || []).filter(v => { const x = parse(v) || {}; return x.s === 'p' || (x.pay && x.pay.s === 'p'); }).length }; }
      if (ins && ins.s === 'a' && (ins.until || 0) < Date.now()) { out.expired = true; out.msgs = await fil(me); out.unread = +us || 0; if (q.read) await redis(c, [['HDEL', P + 'eus', me]]); }
      else if (ins && ins.s === 'a') {
        const L = await lists();
        const mine = x => !x.subj || x.subj === 'all' || (ins.subj || []).includes(x.subj);
        out.cours = L.cours.filter(mine); out.lecons = L.lecons.filter(mine); out.devoirs = L.devoirs.filter(mine); out.ann = L.ann;
        out.live = L.live && Date.now() - L.live.t < 4 * 3600000 ? L.live.room : null;
        out.msgs = await fil(me); out.unread = +us || 0;
        if (q.read) await redis(c, [['HDEL', P + 'eus', me]]);
      }
      return send(200, out);
    }

    if (a === 'inscrire' && req.method === 'POST') {
      if (await limited('ins', 5)) return send(429, { error: 'rate_limit' });
      const b = await readBody(req) || {};
      const [old] = await redis(c, [['HGET', P + 'eins', me]]);
      const o = parse(old);
      if (o && o.s === 'a') return send(409, { error: 'already_student' });
      const subj = (Array.isArray(b.subj) ? b.subj : []).filter(x => SIDS.includes(x));
      const it = { name: clean(b.name, 60), phone: clean(b.phone, 30), age: clean(b.age, 10), subj, level: LEVELS.includes(b.level) ? b.level : '',
        slot: (Array.isArray(b.slot) ? b.slot : [b.slot]).filter(x => SLOTS.includes(x)), msg: cleanML(b.msg, 600), s: 'p', t: Date.now() };
      if (!it.name || !it.phone || !subj.length) return send(400, { error: 'missing' });
      await redis(c, [['HSET', P + 'eins', me, JSON.stringify(it)]]);
      return send(200, { ok: true });
    }

    if (a === 'paye' && req.method === 'POST') {
      const [raw] = await redis(c, [['HGET', P + 'eins', me]]);
      const ins = parse(raw);
      if (!ins || ins.s !== 'a') return send(403, { error: 'not_student' });
      if (await limited('pay', 5)) return send(429, { error: 'rate_limit' });
      const b = await readBody(req) || {};
      const m = b.method === 'om' ? 'om' : 'wave', ph = clean(b.phone, 30);
      if (!ph) return send(400, { error: 'missing' });
      ins.pay = { m, ph, ref: clean(b.ref, 60), t: Date.now(), s: 'p' };
      await redis(c, [['HSET', P + 'eins', me, JSON.stringify(ins)]]);
      return send(200, { ok: true });
    }
    if (a === 'msg' && req.method === 'POST') {
      const [raw] = await redis(c, [['HGET', P + 'eins', me]]);
      const ins = parse(raw);
      if (!ins || ins.s !== 'a') return send(403, { error: 'not_student' });
      if (await limited('msg', 10)) return send(429, { error: 'rate_limit' });
      const b = await readBody(req) || {}, x = cleanML(b.text, 1000);
      if (!x) return send(400, { error: 'empty' });
      await push(me, 's', x);
      return send(200, { ok: true, msgs: await fil(me) });
    }

    // ---- enseignant (administrateur) ----
    if (!isAdmin) return send(403, { error: 'not_admin' });

    if (a === 'eleves') {
      const [all, un] = await redis(c, [['HGETALL', P + 'eins'], ['HGETALL', P + 'eun']]);
      const unr = {}; for (let j = 0; un && j < un.length; j += 2) unr[un[j]] = +un[j + 1] || 0;
      const st = []; for (let j = 0; all && j < all.length; j += 2) { const v = parse(all[j + 1]); if (v) st.push(Object.assign({ u: all[j], ut: unr[all[j]] || 0 }, v)); }
      st.sort((x, y) => (x.s === 'p' ? 0 : 1) - (y.s === 'p' ? 0 : 1) || y.t - x.t);
      const L = await lists();
      return send(200, { students: st, cours: L.cours, lecons: L.lecons, devoirs: L.devoirs, ann: L.ann, live: L.live && Date.now() - L.live.t < 4 * 3600000 ? L.live.room : null, prof });
    }
    if (a === 'fil') {
      const u = String(q.user || '');
      if (!u || u.length > 120) return send(400, { error: 'bad_user' });
      await redis(c, [['HDEL', P + 'eun', u]]);
      return send(200, { msgs: await fil(u) });
    }
    if (req.method !== 'POST') return send(405, { error: 'method' });
    const b = await readBody(req) || {};
    if (a === 'statut') {
      const u = String(b.user || ''), s = b.s;
      const [raw] = await redis(c, [['HGET', P + 'eins', u]]);
      const ins = parse(raw);
      if (!ins) return send(404, { error: 'not_found' });
      if (s === 'x') { await redis(c, [['HDEL', P + 'eins', u], ['DEL', P + 'emsg:' + u], ['HDEL', P + 'eun', u], ['HDEL', P + 'eus', u]]); return send(200, { ok: true }); }
      if (s !== 'a' && s !== 'r') return send(400, { error: 'bad_status' });
      ins.s = s; ins.ta = Date.now(); if (s === 'a' && !ins.until) ins.until = Date.now() + MONTH;
      await redis(c, [['HSET', P + 'eins', u, JSON.stringify(ins)]]);
      if (s === 'a') await push(u, 't', 'Bienvenue ! Ton inscription est confirmée. Tu peux maintenant suivre les cours.');
      return send(200, { ok: true });
    }
    if (a === 'payok' || a === 'payno') {
      const u = String(b.user || '');
      const [raw] = await redis(c, [['HGET', P + 'eins', u]]);
      const ins = parse(raw);
      if (!ins) return send(404, { error: 'not_found' });
      if (a === 'payok') { ins.until = Math.max(Date.now(), ins.until || 0) + MONTH; ins.paid = true; if (ins.pay) ins.pay.s = 'ok'; }
      else if (ins.pay) ins.pay.s = 'no';
      await redis(c, [['HSET', P + 'eins', u, JSON.stringify(ins)]]);
      await push(u, 't', a === 'payok' ? 'Paiement reçu, merci ! Tes cours continuent pour un mois.' : 'Je n’ai pas reçu ton paiement. Vérifie et renvoie-le, s’il te plaît.');
      return send(200, { ok: true, until: ins.until });
    }
    if (a === 'amsg') {
      const u = String(b.user || ''), x = cleanML(b.text, 1000);
      if (!u || !x) return send(400, { error: 'empty' });
      await push(u, 't', x);
      return send(200, { ok: true, msgs: await fil(u) });
    }
    if (a === 'profil') {
      const p = { name: clean(b.name, 60) || DEF.name, bio: cleanML(b.bio, 500), sched: clean(b.sched, 120), photo: isUrl(b.photo) ? b.photo : '',
        price: Math.max(0, Math.min(1000000, parseInt(b.price, 10) || 0)), wave: clean(b.wave, 30), om: clean(b.om, 30) };
      await redis(c, [['SET', P + 'ecole', JSON.stringify(p)]]);
      return send(200, { ok: true, prof: p });
    }
    if (a === 'add') {
      const k = b.k, i = b.item || {};
      if (!KINDS[k]) return send(400, { error: 'bad_kind' });
      const subj = SIDS.includes(i.subj) ? i.subj : 'all';
      const it = { id: crypto.randomBytes(6).toString('hex'), t: Date.now(), subj };
      if (k === 'cours') { if (!/^\d{4}-\d{2}-\d{2}$/.test(i.date || '') || !/^\d{2}:\d{2}$/.test(i.time || '')) return send(400, { error: 'bad_date' }); it.date = i.date; it.time = i.time; it.note = clean(i.note, 120); }
      else if (k === 'lecons') { it.title = clean(i.title, 120); it.text = cleanML(i.text, 6000); it.link = isLink(i.link) ? i.link : ''; if (!it.title) return send(400, { error: 'empty' }); }
      else if (k === 'devoirs') { it.title = clean(i.title, 160); it.due = /^\d{4}-\d{2}-\d{2}$/.test(i.due || '') ? i.due : ''; if (!it.title) return send(400, { error: 'empty' }); }
      else { it.text = cleanML(i.text, 1000); if (!it.text) return send(400, { error: 'empty' }); }
      await redis(c, [[k === 'ann' || k === 'lecons' ? 'LPUSH' : 'RPUSH', P + 'e' + k, JSON.stringify(it)], ['LTRIM', P + 'e' + k, 0, KINDS[k] - 1]]);
      return send(200, { ok: true, item: it });
    }
    if (a === 'del') {
      const k = b.k;
      if (!KINDS[k]) return send(400, { error: 'bad_kind' });
      const [l] = await redis(c, [['LRANGE', P + 'e' + k, 0, -1]]);
      const v = (l || []).find(x => (parse(x) || {}).id === b.id);
      if (v) await redis(c, [['LREM', P + 'e' + k, 1, v]]);
      return send(200, { ok: true });
    }
    if (a === 'live') {
      if (b.on) { const room = 'ArJangou-' + crypto.randomBytes(8).toString('hex'); await redis(c, [['SET', P + 'elive', JSON.stringify({ room, t: Date.now() })]]); return send(200, { ok: true, room }); }
      await redis(c, [['DEL', P + 'elive']]);
      return send(200, { ok: true });
    }
    return send(400, { error: 'bad_action' });
  } catch (e) { return send(502, { error: 'storage' }); }
};
