// École en ligne DEFTERAM « Cours en ligne · Ar Jangou »
// Chaque enseignant a sa classe (20 élèves au maximum). L'élève paie SON enseignant (1000 F la 1re fois, puis 500 F par mois)
// par Wave ou Orange Money ; l'enseignant confirme le paiement reçu. La direction parle avec chaque candidat puis le confirme.
// Chaque enseignant paie 500 F par mois à la direction : son école est ouverte seulement quand ce mois est payé et confirmé.
// Public :
//   GET  /api/courses?a=list                → réglages, matières (programmes), enseignants (profil, places, heures, numéros)
//   GET  /api/courses?a=voice&id=<id>       → message vocal (lien secret)
// Compte connecté (Authorization: Bearer <token>) :
//   GET  /api/courses?a=me                  → mes classes, messages non lus, rôle, appel en cours
//   POST /api/courses?a=apply               { subjects, bio, sched, wave, om }   → devenir enseignant
//   POST /api/courses?a=join                { teacher, method, phone, ref }      → l'élève a payé son enseignant
//   POST /api/courses?a=thread | send       { room, student?, text?, audio? }   → room : dir, prof, c:<enseignant>
// Enseignant :
//   GET  /api/courses?a=myclass             → élèves, demandes, appel
//   POST /api/courses?a=confirm | refuse | remove { student }  · ?a=tprofile {…} · ?a=call { stop? } · ?a=tpay { method, phone, ref }
// Direction (administrateur) :
//   GET  /api/courses?a=staff               → candidats, enseignants, messages
//   POST /api/courses?a=tapprove | treject | tremove | tpayok | tpayno { user } · ?a=school_save { d, from, to, first, month, max, tfee, dwave, dom }
const crypto = require('crypto');
const { P, cfg, redis, sha, readBody } = require('./_lib');

const ID_RE = /^[a-z0-9._-]{3,30}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,80}\.[^\s@]{2,20}$/;
const DAY = 86400000;
const nameOf = id => { const at = id.indexOf('@'); return at > -1 ? id.slice(0, at) : id; };

const L3 = (fr, en, ar) => ({ fr, en, ar });
const COURSES = [
  { id: 'quran', icon: '📖', order: 1, color: 'g', sched: { d: [1, 3, 5], from: '20:00', to: '21:00' },
    title: { fr: 'Cours de Coran', ar: 'دروس القرآن الكريم', en: 'Quran course', ff: 'Janngirde Alkur’aana', wo: 'Njàngum Alxuraan' },
    desc: L3('Apprendre à lire le Coran correctement, le tajwid et la mémorisation, pas à pas avec un enseignant.',
             'Learn to read the Quran correctly, tajwid and memorisation, step by step with a teacher.',
             'تعلّم قراءة القرآن الكريم قراءة صحيحة مع التجويد والحفظ خطوة بخطوة مع معلّم.'),
    program: [
      L3('Niveau 1 · Les lettres arabes : formes, sons (makharij), voyelles et sukun', 'Level 1 · Arabic letters: shapes, sounds (makharij), vowels and sukun', 'المستوى 1 · الحروف العربية: أشكالها ومخارجها والحركات والسكون'),
      L3('Niveau 2 · Lecture syllabe par syllabe (Qaida Nouraniya), tanwin, madd, shadda', 'Level 2 · Reading syllable by syllable (Qaida Nuraniyya), tanwin, madd, shadda', 'المستوى 2 · القراءة بالتهجي (القاعدة النورانية) والتنوين والمد والشدة'),
      L3('Niveau 3 · Règles du tajwid : noun sakina, mim sakina, qalqala, les madd', 'Level 3 · Tajwid rules: nun sakinah, mim sakinah, qalqalah, the madd', 'المستوى 3 · أحكام التجويد: النون الساكنة والميم الساكنة والقلقلة والمدود'),
      L3('Niveau 4 · Lecture fluide et mémorisation de Juz ʿAmma, avec correction de la récitation', 'Level 4 · Fluent reading and memorising Juz ʿAmma, with recitation correction', 'المستوى 4 · القراءة المتقنة وحفظ جزء عمّ مع تصحيح التلاوة'),
    ] },
  { id: 'arabe', icon: '✍️', order: 2, color: 'b', sched: { d: [2, 4], from: '20:00', to: '21:00' },
    title: { fr: 'Cours d’arabe', ar: 'دروس اللغة العربية', en: 'Arabic course', ff: 'Janngirde Arabiya', wo: 'Njàngum Araab' },
    desc: L3('Lire, écrire, comprendre et parler l’arabe, de débutant à intermédiaire.',
             'Read, write, understand and speak Arabic, from beginner to intermediate.',
             'القراءة والكتابة والفهم والمحادثة باللغة العربية من المبتدئ إلى المتوسط.'),
    program: [
      L3('Niveau 1 · Alphabet, écriture et lecture des mots simples', 'Level 1 · Alphabet, handwriting and reading simple words', 'المستوى 1 · الحروف والكتابة وقراءة الكلمات البسيطة'),
      L3('Niveau 2 · Vocabulaire du quotidien : famille, maison, école, mosquée, nombres', 'Level 2 · Everyday vocabulary: family, home, school, mosque, numbers', 'المستوى 2 · مفردات الحياة اليومية: الأسرة والبيت والمدرسة والمسجد والأعداد'),
      L3('Niveau 3 · Grammaire de base (nahw et sarf) : phrase nominale, verbale, conjugaison', 'Level 3 · Basic grammar (nahw and sarf): nominal and verbal sentences, conjugation', 'المستوى 3 · مبادئ النحو والصرف: الجملة الاسمية والفعلية وتصريف الأفعال'),
      L3('Niveau 4 · Conversation, compréhension de textes et petites rédactions', 'Level 4 · Conversation, reading comprehension and short writing', 'المستوى 4 · المحادثة وفهم النصوص والتعبير الكتابي'),
    ] },
  { id: 'francais', icon: '🇫🇷', order: 3, color: 'r', sched: { d: [6], from: '10:00', to: '12:00' },
    title: { fr: 'Cours de français', ar: 'دروس اللغة الفرنسية', en: 'French course', ff: 'Janngirde Farayse', wo: 'Njàngum Faranse' },
    desc: L3('Bien lire, écrire et parler le français, pour l’école, le travail et la vie de tous les jours.',
             'Read, write and speak French well, for school, work and daily life.',
             'إتقان القراءة والكتابة والتحدث بالفرنسية للدراسة والعمل والحياة اليومية.'),
    program: [
      L3('Niveau 1 · Alphabet, sons et lecture de phrases simples', 'Level 1 · Alphabet, sounds and reading simple sentences', 'المستوى 1 · الحروف والأصوات وقراءة الجمل البسيطة'),
      L3('Niveau 2 · Vocabulaire et expressions du quotidien, se présenter', 'Level 2 · Everyday vocabulary and expressions, introducing yourself', 'المستوى 2 · المفردات والعبارات اليومية والتعريف بالنفس'),
      L3('Niveau 3 · Grammaire et conjugaison : présent, passé composé, futur, accords', 'Level 3 · Grammar and conjugation: present, past, future, agreement', 'المستوى 3 · القواعد وتصريف الأفعال: المضارع والماضي والمستقبل'),
      L3('Niveau 4 · Expression orale et écrite : lettres, récits, débats', 'Level 4 · Speaking and writing: letters, stories, discussions', 'المستوى 4 · التعبير الشفهي والكتابي: الرسائل والقصص والنقاش'),
    ] },
  { id: 'anglais', icon: '🇬🇧', order: 4, color: 'v', sched: { d: [6], from: '15:00', to: '17:00' },
    title: { fr: 'Cours d’anglais', ar: 'دروس اللغة الإنجليزية', en: 'English course', ff: 'Janngirde Engale', wo: 'Njàngum Angale' },
    desc: L3('Parler et comprendre l’anglais pas à pas, du niveau débutant à la conversation.',
             'Speak and understand English step by step, from beginner to conversation.',
             'تعلّم التحدث والفهم باللغة الإنجليزية خطوة بخطوة من المبتدئ إلى المحادثة.'),
    program: [
      L3('Niveau 1 · Alphabet, prononciation, salutations et nombres', 'Level 1 · Alphabet, pronunciation, greetings and numbers', 'المستوى 1 · الحروف والنطق والتحية والأعداد'),
      L3('Niveau 2 · Vocabulaire essentiel : famille, métiers, achats, voyages', 'Level 2 · Essential vocabulary: family, jobs, shopping, travel', 'المستوى 2 · المفردات الأساسية: الأسرة والمهن والتسوق والسفر'),
      L3('Niveau 3 · Grammaire : to be, présent simple et continu, passé, questions', 'Level 3 · Grammar: to be, present simple and continuous, past, questions', 'المستوى 3 · القواعد: فعل الكينونة والمضارع البسيط والمستمر والماضي والأسئلة'),
      L3('Niveau 4 · Conversation guidée et compréhension orale avec messages vocaux', 'Level 4 · Guided conversation and listening with voice messages', 'المستوى 4 · محادثة موجّهة وفهم الاستماع عبر الرسائل الصوتية'),
    ] },
];
const CIDS = COURSES.map(x => x.id);
// Réglages de l'école (modifiables par la direction) : heures d'ouverture (heure du Sénégal = UTC),
// prix payé par l'élève à son enseignant (1re fois, puis chaque mois), nombre maximum d'élèves par enseignant.
const SCHOOL = { d: [1, 2, 3, 4, 5, 6], from: '08:00', to: '22:00', first: 1000, month: 500, max: 20, tfee: 500, dwave: '+221 710876405', dom: '+221 710876405' };
const tActive = t => !!(t && t.until > Date.now());   // l'école de l'enseignant est ouverte (mois payé à la direction)
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const parse = x => { try { return x ? JSON.parse(x) : null; } catch (e) { return null; } };
const cleanSched = (s, def) => { s = s || {}; const d = [...new Set((Array.isArray(s.d) ? s.d : []).map(Number).filter(x => x >= 0 && x <= 6))].sort();
  return { d: d.length ? d : def.d, from: HM.test(s.from) ? s.from : def.from, to: HM.test(s.to) ? s.to : def.to }; };
const cleanNum = s => String(s || '').replace(/[^\d+ ]/g, '').trim().slice(0, 20);
const status = e => !e ? null : e.s === 'a' ? (e.until > Date.now() ? 'a' : 'x') : e.s;   // a actif · p en attente · r refusé · x expiré
// Horaires de l'enseignant : jusqu'à 4 créneaux (matin, après-midi, soir…), chacun avec ses jours et ses heures
const cleanSlots = b => { const def = { d: [1, 3, 5], from: '20:00', to: '21:00' };
  let arr = (Array.isArray(b.slots) ? b.slots : (b.sched ? [b.sched] : [])).slice(0, 4).map(x => cleanSched(x, def)).filter(x => x.from < x.to);
  if (!arr.length) arr = [def]; return arr.sort((x, y) => x.from < y.from ? -1 : 1); };
const cleanTeacher = b => ({
  subjects: (Array.isArray(b.subjects) ? b.subjects : []).filter(x => CIDS.indexOf(x) > -1).slice(0, 4),
  bio: String(b.bio || '').trim().slice(0, 1500),
  slots: cleanSlots(b), sched: cleanSlots(b)[0],
  wave: cleanNum(b.wave), om: cleanNum(b.om),
});

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const send = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); };
  const c = cfg();
  if (!c) return send(503, { error: 'not_configured' });
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  const a = q.a;
  try {
    const [traw, scraw] = await redis(c, [['HGETALL', P + 'teachers'], ['GET', P + 'school']]);
    const teachers = {}; for (let i = 0; traw && i < traw.length; i += 2) { const t = parse(traw[i + 1]); if (t && t.subjects) teachers[traw[i]] = t; }
    const sc = parse(scraw) || {};
    const school = Object.assign(cleanSched(sc, SCHOOL), {
      first: sc.first >= 0 ? sc.first : SCHOOL.first, month: sc.month >= 0 ? sc.month : SCHOOL.month, max: sc.max > 0 ? sc.max : SCHOOL.max,
      tfee: sc.tfee >= 0 ? sc.tfee : SCHOOL.tfee, dwave: sc.dwave !== undefined ? sc.dwave : SCHOOL.dwave, dom: sc.dom !== undefined ? sc.dom : SCHOOL.dom });
    const TU = Object.keys(teachers);
    async function profiles(us) {
      if (!us.length) return {};
      const r = await redis(c, us.map(u => ['GET', P + 'prof:' + u]));
      const o = {}; us.forEach((u, i) => { const p = parse(r[i]) || {}; o[u] = { name: p.name || nameOf(u), pv: p.pv || 0 }; }); return o;
    }
    async function counts(us) {   // élèves actifs par enseignant
      if (!us.length) return {};
      const r = await redis(c, us.map(u => ['HVALS', P + 'cls:' + u]));
      const o = {}; us.forEach((u, i) => { o[u] = (r[i] || []).filter(v => status(parse(v)) === 'a').length; }); return o;
    }

    if (a === 'list') {
      const [pr, cn] = await Promise.all([profiles(TU), counts(TU)]);
      return send(200, {
        school, subjects: COURSES.map(x => ({ id: x.id, icon: x.icon, color: x.color, title: x.title, desc: x.desc, program: x.program })),
        teachers: TU.map(u => Object.assign({ u, count: cn[u] || 0 }, pr[u], { subjects: teachers[u].subjects, bio: teachers[u].bio, sched: teachers[u].sched, slots: teachers[u].slots || [teachers[u].sched], wave: teachers[u].wave, om: teachers[u].om, t: teachers[u].t || 0, active: tActive(teachers[u]) }))
          .sort((x, y) => x.t - y.t),
      });
    }
    if (a === 'voice') {
      const id = String(q.id || '');
      if (!/^[A-Za-z0-9_-]{20,40}$/.test(id)) return send(400, { error: 'bad_id' });
      const [raw] = await redis(c, [['GET', P + 'vm:' + id]]);
      const v = parse(raw);
      if (!v) return send(404, { error: 'not_found' });
      const buf = Buffer.from(v.d, 'base64');
      res.statusCode = 200; res.setHeader('Content-Type', v.m); res.setHeader('Content-Length', buf.length);
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      return res.end(buf);
    }

    const hm = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization || '');
    if (!hm) return send(401, { error: 'not_signed_in' });
    const [me, admin] = await redis(c, [['GET', P + 'sess:' + sha(hm[1])], ['GET', P + 'admin']]);
    if (!me) return send(401, { error: 'not_signed_in' });
    const isAdmin = admin === me, isTeacher = !!teachers[me];
    async function limited(kind, max) {
      const k = P + 'rl:' + kind + ':' + sha(me).slice(0, 16) + ':' + Math.floor(Date.now() / 60000);
      const [n] = await redis(c, [['INCR', k], ['EXPIRE', k, 120]]);
      return n > max;
    }
    const sumUt = h => { let n = 0; for (let j = 1; h && j < h.length; j += 2) n += (parse(h[j]) || {}).ut || 0; return n; };
    async function threads(h) {
      const out = []; for (let j = 0; h && j < h.length; j += 2) { const v = parse(h[j + 1]); if (v) out.push({ u: h[j], t: v.t, x: v.x, ut: v.ut || 0 }); }
      const pr = await profiles(out.map(t => t.u)); out.forEach(t => Object.assign(t, pr[t.u])); return out.sort((x, y) => y.t - x.t);
    }
    async function callOf(t) { const [r] = await redis(c, [['GET', P + 'call:' + t]]); return parse(r); }

    if (a === 'me') {
      const myTs = (await redis(c, [['SMEMBERS', P + 'stc:' + me]]))[0] || [];
      const r = await redis(c, myTs.map(t => ['HGET', P + 'cls:' + t, me]).concat(myTs.map(t => ['HGET', P + 'thi:c:' + t, me]), myTs.map(t => ['GET', P + 'call:' + t]),
        [['HGET', P + 'thi:dir', me], ['HGET', P + 'thi:prof', me], ['HGET', P + 'tapp', me]]));
      const n = myTs.length, classes = {}; let unread = 0;
      myTs.forEach((t, i) => { const e = parse(r[i]); if (!e) return; const th = parse(r[n + i]) || {}; const st = status(e), call = parse(r[2 * n + i]);
        classes[t] = { s: st, until: e.until || 0, paid: !!e.paid, unread: st === 'a' ? th.us || 0 : 0, call: st === 'a' && call ? call.room : null }; unread += classes[t].unread; });
      const dir = (parse(r[3 * n]) || {}).us || 0, prof = isTeacher ? (parse(r[3 * n + 1]) || {}).us || 0 : 0;
      const app = parse(r[3 * n + 2]);
      const out = { user: nameOf(me), admin: isAdmin, teacher: isTeacher, app: app ? { s: app.s } : null, classes, unread, dir, prof };
      if (isTeacher) {
        const [cl, ti, call] = await redis(c, [['HVALS', P + 'cls:' + me], ['HGETALL', P + 'thi:c:' + me], ['GET', P + 'call:' + me]]);
        out.tc = { pending: (cl || []).filter(v => (parse(v) || {}).s === 'p').length, unread: sumUt(ti), count: (cl || []).filter(v => status(parse(v)) === 'a').length, call: !!call,
          active: tActive(teachers[me]), until: teachers[me].until || 0, pay: teachers[me].pay ? teachers[me].pay.s : null };
      }
      if (isAdmin) {
        const [ap, d1, d2] = await redis(c, [['HVALS', P + 'tapp'], ['HGETALL', P + 'thi:dir'], ['HGETALL', P + 'thi:prof']]);
        out.adm = { apps: (ap || []).filter(v => (parse(v) || {}).s === 'p').length + TU.filter(u => teachers[u].pay && teachers[u].pay.s === 'p').length, dir: sumUt(d1), prof: sumUt(d2) };
      }
      return send(200, out);
    }

    if (a === 'myclass') {   // l'enseignant : ses élèves, ses demandes, l'appel en cours
      const t = isAdmin && q.t && teachers[q.t] ? q.t : me;
      if (!teachers[t]) return send(403, { error: 'not_teacher' });
      const [cl, ti, call] = await redis(c, [['HGETALL', P + 'cls:' + t], ['HGETALL', P + 'thi:c:' + t], ['GET', P + 'call:' + t]]);
      const th = {}; for (let j = 0; ti && j < ti.length; j += 2) th[ti[j]] = parse(ti[j + 1]) || {};
      const st = []; for (let j = 0; cl && j < cl.length; j += 2) { const e = parse(cl[j + 1]); if (!e) continue; const u = cl[j];
        st.push({ u, s: status(e), until: e.until || 0, m: e.m, ph: e.ph, ref: e.ref, t: e.t, price: e.price, paid: !!e.paid, ut: (th[u] || {}).ut || 0, x: (th[u] || {}).x || '', lt: (th[u] || {}).t || 0 }); }
      const pr = await profiles(st.map(s => s.u)); st.forEach(s => Object.assign(s, pr[s.u]));
      st.sort((x, y) => ({ p: 0, a: 1, x: 2, r: 3 }[x.s] - { p: 0, a: 1, x: 2, r: 3 }[y.s]) || (y.lt || y.t) - (x.lt || x.t));
      return send(200, { students: st, max: school.max, call: parse(call), room: teachers[t].room, active: tActive(teachers[t]), until: teachers[t].until || 0, pay: teachers[t].pay || null });
    }

    if (a === 'staff') {
      if (!isAdmin) return send(403, { error: 'not_admin' });
      const [ap, d1, d2] = await redis(c, [['HGETALL', P + 'tapp'], ['HGETALL', P + 'thi:dir'], ['HGETALL', P + 'thi:prof']]);
      const apps = []; for (let j = 0; ap && j < ap.length; j += 2) { const v = parse(ap[j + 1]); if (v && v.s === 'p') apps.push(Object.assign({ u: ap[j] }, v)); }
      const [pa, cn, pt] = await Promise.all([profiles(apps.map(x => x.u)), counts(TU), profiles(TU)]);
      apps.forEach(x => Object.assign(x, pa[x.u]));
      const prof = await threads(d2);
      return send(200, { apps, teachers: TU.map(u => Object.assign({ u, count: cn[u] || 0, subjects: teachers[u].subjects, ut: (prof.find(t => t.u === u) || {}).ut || 0,
          active: tActive(teachers[u]), until: teachers[u].until || 0, pay: teachers[u].pay && teachers[u].pay.s === 'p' ? teachers[u].pay : null }, pt[u])),
        dir: await threads(d1), prof, school });
    }

    if (req.method !== 'POST') return send(400, { error: 'bad_action' });
    const b = await readBody(req, 1500000);
    if (b === null) return send(413, { error: 'audio_too_large' });

    if (a === 'apply') {   // devenir enseignant : la direction parle avec la personne, puis confirme
      if (isTeacher) return send(409, { error: 'already_teacher' });
      if (await limited('app', 10)) return send(429, { error: 'rate_limit' });
      const t = cleanTeacher(b);
      if (!t.subjects.length) return send(400, { error: 'no_course' });
      if (!t.wave && !t.om) return send(400, { error: 'bad_phone' });
      const pay = { m: b.paym === 'om' ? 'om' : 'wave', ph: cleanNum(b.payph), ref: String(b.payref || '').trim().slice(0, 80), t: Date.now() };
      if (pay.ph.replace(/\D/g, '').length < 7) return send(400, { error: 'bad_pay_phone' });
      await redis(c, [['HSET', P + 'tapp', me, JSON.stringify(Object.assign(t, { s: 'p', t: Date.now(), pay }))]]);
      return send(200, { ok: true });
    }
    if (a === 'tprofile') {   // l'enseignant modifie ses matières, ses heures, ses numéros
      if (!isTeacher) return send(403, { error: 'not_teacher' });
      const t = cleanTeacher(b);
      if (!t.subjects.length) return send(400, { error: 'no_course' });
      if (!t.wave && !t.om) return send(400, { error: 'bad_phone' });
      await redis(c, [['HSET', P + 'teachers', me, JSON.stringify(Object.assign({}, teachers[me], t))]]);
      return send(200, { ok: true });
    }

    if (a === 'tpay') {   // l'enseignant a payé son mois à la direction
      if (!isTeacher) return send(403, { error: 'not_teacher' });
      if (teachers[me].pay && teachers[me].pay.s === 'p') return send(409, { error: 'already_pending' });
      const pay = { s: 'p', m: b.method === 'om' ? 'om' : 'wave', ph: cleanNum(b.phone), ref: String(b.ref || '').trim().slice(0, 80), t: Date.now() };
      if (pay.ph.replace(/\D/g, '').length < 7) return send(400, { error: 'bad_phone' });
      teachers[me].pay = pay; await redis(c, [['HSET', P + 'teachers', me, JSON.stringify(teachers[me])]]);
      return send(200, { ok: true });
    }

    if (a === 'join') {   // l'élève a payé son enseignant : il envoie sa demande
      const t = String(b.teacher || '');
      if (!teachers[t]) return send(404, { error: 'no_teacher' });
      if (t === me) return send(400, { error: 'self' });
      if (!tActive(teachers[t])) return send(409, { error: 'school_closed' });
      if (await limited('join', 10)) return send(429, { error: 'rate_limit' });
      const phone = cleanNum(b.phone), ref = String(b.ref || '').trim().slice(0, 80);
      if (phone.replace(/\D/g, '').length < 7) return send(400, { error: 'bad_phone' });
      const [old, vals] = await redis(c, [['HGET', P + 'cls:' + t, me], ['HVALS', P + 'cls:' + t]]);
      const o = parse(old), st = status(o);
      if (st === 'p') return send(409, { error: 'already_pending' });
      if (st !== 'a' && (vals || []).filter(v => status(parse(v)) === 'a').length >= school.max) return send(409, { error: 'class_full' });
      const price = o && o.paid ? school.month : school.first;
      const rec = { s: 'p', m: b.method === 'om' ? 'om' : 'wave', ph: phone, ref, t: Date.now(), until: o ? o.until || 0 : 0, paid: !!(o && o.paid), price };
      await redis(c, [['HSET', P + 'cls:' + t, me, JSON.stringify(rec)], ['SADD', P + 'stc:' + me, t]]);
      return send(200, { ok: true, s: 'p', price });
    }

    if (a === 'confirm' || a === 'refuse' || a === 'remove') {   // l'enseignant confirme le paiement reçu (ou la direction)
      const t = isAdmin && b.teacher && teachers[b.teacher] ? String(b.teacher) : me;
      if (!teachers[t]) return send(403, { error: 'not_teacher' });
      const u = String(b.student || '').toLowerCase();
      const [old, vals] = await redis(c, [['HGET', P + 'cls:' + t, u], ['HVALS', P + 'cls:' + t]]);
      const o = parse(old);
      if (!o) return send(404, { error: 'no_student' });
      const now = Date.now(), msg = { i: crypto.randomBytes(6).toString('hex'), f: 'sys', n: nameOf(me), t: now };
      if (a === 'confirm') {
        if (!tActive(teachers[t])) return send(409, { error: 'school_closed' });
        if (status(o) !== 'a' && (vals || []).filter(v => status(parse(v)) === 'a').length >= school.max) return send(409, { error: 'class_full' });
        o.s = 'a'; o.until = Math.max(now, o.until || 0) + 30 * DAY; o.paid = true; o.v = now; msg.x = 'ok:' + o.until;
      } else if (a === 'refuse') { o.s = 'r'; o.v = now; msg.x = 'refused'; }
      else { o.s = 'x'; o.until = now; o.v = now; msg.x = 'removed'; }
      const ik = P + 'thi:c:' + t, [info] = await redis(c, [['HGET', ik, u]]);
      const inf = parse(info) || { ut: 0, us: 0 }; inf.t = now; inf.us = (inf.us || 0) + 1; inf.x = a === 'confirm' ? '✅' : '⛔';
      await redis(c, [['HSET', P + 'cls:' + t, u, JSON.stringify(o)], ['RPUSH', P + 'thr:c:' + t + ':' + u, JSON.stringify(msg)], ['HSET', ik, u, JSON.stringify(inf)]]);
      return send(200, { ok: true, s: status(o), until: o.until || 0 });
    }

    if (a === 'call') {   // appel de groupe (Jitsi Meet) de l'enseignant avec ses élèves
      if (!isTeacher) return send(403, { error: 'not_teacher' });
      if (!tActive(teachers[me]) && !b.stop) return send(409, { error: 'school_closed' });
      let room = teachers[me].room;
      if (!room) { room = 'ArJangou-' + crypto.randomBytes(9).toString('hex'); teachers[me].room = room; await redis(c, [['HSET', P + 'teachers', me, JSON.stringify(teachers[me])]]); }
      if (b.stop) { await redis(c, [['DEL', P + 'call:' + me]]); return send(200, { ok: true, live: false }); }
      await redis(c, [['SET', P + 'call:' + me, JSON.stringify({ room, t: Date.now() }), 'EX', 3 * 3600]]);
      return send(200, { ok: true, live: true, room });
    }

    if (a === 'thread' || a === 'send') {
      // Salles : « dir » (chacun ↔ direction), « prof » (enseignant ↔ direction), « c:<enseignant> » (élève ↔ son enseignant)
      const room = String(b.room || ''), other = b.student && String(b.student).toLowerCase() !== me ? String(b.student).toLowerCase() : null;
      let key, user = me, staff = false;
      if (room === 'dir') {
        if (other) { if (!isAdmin) return send(403, { error: 'not_admin' }); const [ex] = await redis(c, [['EXISTS', P + 'user:' + other]]); if (!ex) return send(404, { error: 'no_student' }); user = other; staff = true; }
        key = 'dir';
      } else if (room === 'prof') {
        if (other) { if (!isAdmin) return send(403, { error: 'not_admin' }); if (!teachers[other]) return send(404, { error: 'no_student' }); user = other; staff = true; }
        else if (!isTeacher) return send(403, { error: 'not_teacher' });
        key = 'prof';
      } else if (/^c:[a-z0-9@._-]{3,100}$/.test(room) && teachers[room.slice(2)]) {
        const t = room.slice(2);
        if (other) { if (t !== me && !isAdmin) return send(403, { error: 'not_teacher' }); user = other; staff = true; }
        const [er] = await redis(c, [['HGET', P + 'cls:' + t, user]]);
        const st = status(parse(er));
        if (!er) return send(staff ? 404 : 403, { error: staff ? 'no_student' : 'not_enrolled' });
        if (!staff && st !== 'a' && a === 'send') return send(403, { error: 'not_enrolled', s: st });
        key = 'c:' + t;
      } else return send(400, { error: 'bad_room' });
      const tk = P + 'thr:' + key + ':' + user, ik = P + 'thi:' + key;
      if (a === 'thread') {
        const [list, info] = await redis(c, [['LRANGE', tk, -200, -1], ['HGET', ik, user]]);
        const inf = parse(info);
        if (inf && (staff ? inf.ut : inf.us)) { if (staff) inf.ut = 0; else inf.us = 0; await redis(c, [['HSET', ik, user, JSON.stringify(inf)]]); }
        const pr = await profiles([user]);
        return send(200, { msgs: (list || []).map(parse).filter(Boolean), user: pr[user] });
      }
      if (await limited('msg', 40)) return send(429, { error: 'rate_limit' });
      const text = String(b.text || '').trim().slice(0, 4000);
      const [mp] = await redis(c, [['GET', P + 'prof:' + me]]);
      const msg = { i: crypto.randomBytes(6).toString('hex'), f: staff ? 't' : 's', u: me, n: (parse(mp) || {}).name || nameOf(me), t: Date.now() };
      if (staff && key !== 'c:' + me) msg.r = 'dir';
      const cmds = [];
      if (b.audio && b.audio.data) {
        const d = String(b.audio.data), m = String(b.audio.mime || '');
        if (!/^audio\/(webm|ogg|mp4|mpeg|aac|x-m4a|wav)(;[ a-z0-9=.,-]*)?$/i.test(m)) return send(400, { error: 'bad_audio' });
        if (d.length > 1100000 || !/^[A-Za-z0-9+/=]+$/.test(d)) return send(413, { error: 'audio_too_large' });
        const vid = crypto.randomBytes(18).toString('base64url');
        cmds.push(['SET', P + 'vm:' + vid, JSON.stringify({ m: m.split(';')[0], d }), 'EX', 180 * 86400]);
        msg.a = vid; msg.d = Math.max(0, Math.min(600, Math.round(+b.audio.dur || 0)));
      }
      if (text) msg.x = text;
      if (!msg.x && !msg.a) return send(400, { error: 'empty' });
      const [info] = await redis(c, [['HGET', ik, user]]);
      const inf = parse(info) || { ut: 0, us: 0 };
      inf.t = msg.t; inf.x = msg.x ? msg.x.slice(0, 80) : '🎤'; if (staff) inf.us = (inf.us || 0) + 1; else inf.ut = (inf.ut || 0) + 1;
      cmds.push(['RPUSH', tk, JSON.stringify(msg)], ['LTRIM', tk, -500, -1], ['HSET', ik, user, JSON.stringify(inf)]);
      await redis(c, cmds);
      return send(200, { ok: true, msg });
    }

    if (!isAdmin) return send(403, { error: 'not_admin' });   // la suite : direction de l'école seulement
    const u = String(b.user || '').toLowerCase();
    if (a === 'tapprove') {
      const [raw] = await redis(c, [['HGET', P + 'tapp', u]]);
      const app = parse(raw);
      if (!app) return send(404, { error: 'no_user' });
      const rec = Object.assign(cleanTeacher(app), { t: Date.now(), until: Date.now() + 30 * DAY, room: 'ArJangou-' + crypto.randomBytes(9).toString('hex') });
      const msg = { i: crypto.randomBytes(6).toString('hex'), f: 'sys', t: Date.now(), x: 'teacher_ok' };
      await redis(c, [['HSET', P + 'teachers', u, JSON.stringify(rec)], ['HDEL', P + 'tapp', u], ['RPUSH', P + 'thr:dir:' + u, JSON.stringify(msg)],
        ['HSET', P + 'thi:dir', u, JSON.stringify({ t: Date.now(), x: '✅', us: 1, ut: 0 })]]);
      return send(200, { ok: true });
    }
    if (a === 'treject') {
      const [raw] = await redis(c, [['HGET', P + 'tapp', u]]);
      const app = parse(raw); if (!app) return send(404, { error: 'no_user' });
      app.s = 'r'; await redis(c, [['HSET', P + 'tapp', u, JSON.stringify(app)]]);
      return send(200, { ok: true });
    }
    if (a === 'tpayok' || a === 'tpayno') {
      const t = teachers[u]; if (!t) return send(404, { error: 'no_user' });
      const now = Date.now(), msg = { i: crypto.randomBytes(6).toString('hex'), f: 'sys', t: now };
      if (a === 'tpayok') { t.until = Math.max(now, t.until || 0) + 30 * DAY; t.pay = null; msg.x = 'school_ok:' + t.until; }
      else { if (t.pay) t.pay.s = 'r'; msg.x = 'school_refused'; }
      const [info] = await redis(c, [['HGET', P + 'thi:prof', u]]);
      const inf = parse(info) || { ut: 0, us: 0 }; inf.t = now; inf.us = (inf.us || 0) + 1; inf.x = a === 'tpayok' ? '✅' : '⛔';
      await redis(c, [['HSET', P + 'teachers', u, JSON.stringify(t)], ['RPUSH', P + 'thr:prof:' + u, JSON.stringify(msg)], ['HSET', P + 'thi:prof', u, JSON.stringify(inf)]]);
      return send(200, { ok: true, until: t.until || 0 });
    }
    if (a === 'tremove') {
      await redis(c, [['HDEL', P + 'teachers', u], ['DEL', P + 'call:' + u]]);
      return send(200, { ok: true });
    }
    if (a === 'school_save') {
      const n = (x, lo, hi, def) => { x = Math.round(+x); return x >= lo && x <= hi ? x : def; };
      await redis(c, [['SET', P + 'school', JSON.stringify(Object.assign(cleanSched(b, SCHOOL), {
        first: n(b.first, 0, 1000000, SCHOOL.first), month: n(b.month, 0, 1000000, SCHOOL.month), max: n(b.max, 1, 200, SCHOOL.max),
        tfee: n(b.tfee, 0, 1000000, SCHOOL.tfee), dwave: cleanNum(b.dwave), dom: cleanNum(b.dom) }))]]);
      return send(200, { ok: true });
    }
    return send(400, { error: 'bad_action' });
  } catch (err) {
    return send(502, { error: 'storage' });
  }
};
