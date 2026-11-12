// Cours en ligne DEFTERAM : programmes, inscriptions payantes, enseignants, discussion texte + vocal.
// Même base Upstash Redis que /api/auth. Les messages vocaux sont gardés dans Redis (≤ 2 min, ~600 Ko).
//
// Public :
//   GET  /api/courses?a=list                      → { courses, pay }
//   GET  /api/courses?a=voice&id=<id>             → fichier audio (lien secret, non devinable)
// Compte connecté (Authorization: Bearer <token>) :
//   GET  /api/courses?a=me                        → rôle, inscriptions, messages non lus
//   POST /api/courses?a=enroll   { course, method, phone, ref }      → demande d'inscription (après paiement)
//   POST /api/courses?a=thread   { course, student? }                → messages (élève : les siens ; enseignant : d'un élève)
//   POST /api/courses?a=send     { course, student?, text?, audio? } → envoie un message texte ou vocal
//   (course = un cours, « dir » = discussion avec la direction, « prof » = salle des professeurs)
// Enseignant (5 au maximum) ou administrateur :
//   GET  /api/courses?a=teach                     → élèves et discussions de ses cours
// Direction de l'école (administrateur) seulement :
//   GET  /api/courses?a=staff                     → inscriptions à confirmer, discussions élèves et enseignants
//   POST /api/courses?a=validate { course, student, months } / ?a=refuse { course, student }
//   POST /api/courses?a=school_save { d, from, to, tchat }
//   GET  /api/courses?a=teachers
//   POST /api/courses?a=teacher_set { user, courses, password? } / ?a=teacher_del { user }
//   POST /api/courses?a=course_save { id, price, active, per } / ?a=pay_save { wave, om, note }
const crypto = require('crypto');
const { P, cfg, redis, sha, readBody } = require('./_lib');

const MAX_TEACHERS = 5;
const ID_RE = /^[a-z0-9._-]{3,30}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,80}\.[^\s@]{2,20}$/;
const DAY = 86400000;
const scrypt = (pw, salt) => new Promise((ok, no) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => e ? no(e) : ok(k)));
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
const DEF = { price: 2000, per: 'mois', active: true };
const PAY = { wave: '+221 710876405', om: '+221 710876405', note: '' };
// Heures d'ouverture de l'école (heure du Sénégal = UTC) ; tchat : les élèves parlent aussi avec l'enseignant
const SCHOOL = { d: [1, 2, 3, 4, 5, 6], from: '08:00', to: '22:00' };

function parse(x) { try { return x ? JSON.parse(x) : null; } catch (e) { return null; } }
const status = e => !e ? null : e.s === 'a' ? (e.until > Date.now() ? 'a' : 'x') : e.s; // a actif, p en attente, r refusé, x expiré
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
function cleanSched(s, def) {
  s = s || {};
  const d = [...new Set((Array.isArray(s.d) ? s.d : []).map(Number).filter(x => x >= 0 && x <= 6))].sort();
  return { d: d.length ? d : def.d, from: HM.test(s.from) ? s.from : def.from, to: HM.test(s.to) ? s.to : def.to };
}
// Salles de discussion en plus des classes : « dir » (élève ↔ direction), « prof » (enseignant ↔ direction)
const ROOMS = ['dir', 'prof'];

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const send = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); };
  const c = cfg();
  if (!c) return send(503, { error: 'not_configured' });
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  const a = q.a;
  try {
    async function school() {
      const [ov, th, pay, sc] = await redis(c, [['HGETALL', P + 'courses'], ['HGETALL', P + 'teachers'], ['GET', P + 'payinfo'], ['GET', P + 'school']]);
      const o = {}; for (let i = 0; ov && i < ov.length; i += 2) o[ov[i]] = parse(ov[i + 1]) || {};
      const tch = {}; for (let i = 0; th && i < th.length; i += 2) { const t = parse(th[i + 1]) || {}; (t.courses || []).forEach(id => { (tch[id] = tch[id] || []).push(nameOf(th[i])); }); }
      const s = parse(sc) || {};
      return {
        courses: COURSES.map(x => Object.assign({}, x, DEF, o[x.id] || {}, { id: x.id, sched: cleanSched((o[x.id] || {}).sched, x.sched), teachers: tch[x.id] || [] })).sort((x, y) => x.order - y.order),
        pay: Object.assign({}, PAY, parse(pay) || {}),
        school: Object.assign(cleanSched(s, SCHOOL), { tchat: s.tchat !== false }),
      };
    }
    if (a === 'list') return send(200, await school());
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
    const [me, admin, traw, scraw] = await redis(c, [['GET', P + 'sess:' + sha(hm[1])], ['GET', P + 'admin'], ['HGETALL', P + 'teachers'], ['GET', P + 'school']]);
    if (!me) return send(401, { error: 'not_signed_in' });
    const teachers = {}; for (let i = 0; traw && i < traw.length; i += 2) teachers[traw[i]] = parse(traw[i + 1]) || { courses: [] };
    const tchat = (parse(scraw) || {}).tchat !== false;
    const isAdmin = admin === me, isTeacher = !!teachers[me];
    const myT = isAdmin ? CIDS : ((teachers[me] && teachers[me].courses) || []);
    const teaches = id => myT.indexOf(id) > -1;
    async function limited(kind, max) {
      const k = P + 'rl:' + kind + ':' + sha(me).slice(0, 16) + ':' + Math.floor(Date.now() / 60000);
      const [n] = await redis(c, [['INCR', k], ['EXPIRE', k, 120]]);
      return n > max;
    }
    const sumUt = h => { let n = 0; for (let j = 1; h && j < h.length; j += 2) n += (parse(h[j]) || {}).ut || 0; return n; };
    const threads = h => { const out = []; for (let j = 0; h && j < h.length; j += 2) { const v = parse(h[j + 1]); if (v) out.push({ u: h[j], n: nameOf(h[j]), t: v.t, x: v.x, ut: v.ut || 0 }); } return out.sort((x, y) => y.t - x.t); };

    if (a === 'me') {
      const r = await redis(c, CIDS.map(id => ['HGET', P + 'enr:' + id, me]).concat(CIDS.map(id => ['HGET', P + 'thi:' + id, me]), [['HGET', P + 'thi:dir', me], ['HGET', P + 'thi:prof', me]]));
      const enr = {}; let unread = 0;
      CIDS.forEach((id, i) => { const e = parse(r[i]); if (e) enr[id] = { s: status(e), until: e.until || 0 }; const t = parse(r[CIDS.length + i]); if (tchat && t && t.us) { unread += t.us; if (enr[id]) enr[id].unread = t.us; } });
      const dir = (parse(r[2 * CIDS.length]) || {}).us || 0, prof = isTeacher ? (parse(r[2 * CIDS.length + 1]) || {}).us || 0 : 0;
      let tun = 0; const adm = isAdmin ? { pending: 0, dir: 0, prof: 0 } : null;
      if (myT.length && tchat) { const rr = await redis(c, myT.map(id => ['HGETALL', P + 'thi:' + id])); if (!isAdmin) rr.forEach(h => { tun += sumUt(h); }); }
      if (isAdmin) {
        const rr = await redis(c, CIDS.map(id => ['HVALS', P + 'enr:' + id]).concat([['HGETALL', P + 'thi:dir'], ['HGETALL', P + 'thi:prof']]));
        CIDS.forEach((id, i) => (rr[i] || []).forEach(v => { if ((parse(v) || {}).s === 'p') adm.pending++; }));
        adm.dir = sumUt(rr[CIDS.length]); adm.prof = sumUt(rr[CIDS.length + 1]);
      }
      return send(200, { user: nameOf(me), admin: isAdmin, teacher: isTeacher, tcourses: myT, tchat, enr, unread, dir, prof, tunread: tun, adm });
    }

    if (a === 'teach') {
      if (!myT.length) return send(403, { error: 'not_teacher' });
      const rr = await redis(c, myT.map(id => ['HGETALL', P + 'enr:' + id]).concat(myT.map(id => ['HGETALL', P + 'thi:' + id])));
      const out = myT.map((id, i) => {
        const e = rr[i] || [], st = [];
        for (let j = 0; j < e.length; j += 2) { const v = parse(e[j + 1]); if (!v) continue; const s = status(v); if (s === 'a' || s === 'x') st.push({ u: e[j], n: nameOf(e[j]), s, until: v.until || 0 }); }
        st.sort((x, y) => (x.s === 'a' ? 0 : 1) - (y.s === 'a' ? 0 : 1) || x.n.localeCompare(y.n));
        return { id, students: st, threads: tchat ? threads(rr[myT.length + i]) : [] };
      });
      return send(200, { courses: out, tchat });
    }

    if ((a === 'staff' || a === 'teachers') && !isAdmin) return send(403, { error: 'not_admin' });
    if (isAdmin && a === 'staff') {
      const rr = await redis(c, CIDS.map(id => ['HGETALL', P + 'enr:' + id]).concat([['HGETALL', P + 'thi:dir'], ['HGETALL', P + 'thi:prof']]));
      const pending = [], recent = [];
      CIDS.forEach((id, i) => { const e = rr[i] || []; for (let j = 0; j < e.length; j += 2) { const v = parse(e[j + 1]); if (!v) continue; const row = { course: id, u: e[j], n: nameOf(e[j]), s: status(v), m: v.m, ph: v.ph, ref: v.ref, t: v.t, until: v.until || 0 }; if (row.s === 'p') pending.push(row); else recent.push(row); } });
      pending.sort((x, y) => x.t - y.t); recent.sort((x, y) => (y.v || y.t) - (x.v || x.t));
      const prof = threads(rr[CIDS.length + 1]);
      Object.keys(teachers).forEach(u => { if (!prof.some(t => t.u === u)) prof.push({ u, n: nameOf(u), t: 0, x: '', ut: 0 }); });
      return send(200, { pending, students: recent.slice(0, 300), dir: threads(rr[CIDS.length]), prof: prof.map(t => Object.assign(t, { courses: (teachers[t.u] || {}).courses || [] })) });
    }
    if (isAdmin && a === 'teachers') {
      return send(200, { teachers: Object.keys(teachers).map(u => ({ u, n: nameOf(u), courses: teachers[u].courses || [], t: teachers[u].t || 0 })), max: MAX_TEACHERS });
    }

    if (req.method !== 'POST') return send(400, { error: 'bad_action' });
    const b = await readBody(req, 1500000);
    if (b === null) return send(413, { error: 'audio_too_large' });
    const course = String(b.course || '');

    if (a === 'enroll') {
      if (CIDS.indexOf(course) < 0) return send(400, { error: 'bad_course' });
      if (await limited('enr', 10)) return send(429, { error: 'rate_limit' });
      const method = b.method === 'om' ? 'om' : 'wave';
      const phone = String(b.phone || '').replace(/[^\d+ ]/g, '').trim().slice(0, 20);
      const ref = String(b.ref || '').trim().slice(0, 80);
      if (phone.replace(/\D/g, '').length < 7) return send(400, { error: 'bad_phone' });
      const [old] = await redis(c, [['HGET', P + 'enr:' + course, me]]);
      const o = parse(old);
      if (o && status(o) === 'p') return send(409, { error: 'already_pending' });
      const rec = { s: 'p', m: method, ph: phone, ref, t: Date.now(), until: o ? o.until || 0 : 0 };
      await redis(c, [['HSET', P + 'enr:' + course, me, JSON.stringify(rec)]]);
      return send(200, { ok: true, s: 'p' });
    }

    if (a === 'thread' || a === 'send') {
      if (CIDS.indexOf(course) < 0 && ROOMS.indexOf(course) < 0) return send(400, { error: 'bad_course' });
      let student = me, asT = false, st = null;
      const other = b.student && String(b.student).toLowerCase() !== me ? String(b.student).toLowerCase() : null;
      if (course === 'dir') {                       // élève (ou visiteur connecté) ↔ direction
        if (other) { if (!isAdmin) return send(403, { error: 'not_admin' }); student = other; asT = true;
          const [ex] = await redis(c, [['EXISTS', P + 'user:' + student]]); if (!ex) return send(404, { error: 'no_student' }); }
      } else if (course === 'prof') {               // enseignant ↔ direction
        if (other) { if (!isAdmin) return send(403, { error: 'not_admin' }); if (!teachers[other]) return send(404, { error: 'no_student' }); student = other; asT = true; }
        else if (!isTeacher) return send(403, { error: 'not_teacher' });
      } else {                                      // classe : élève ↔ enseignant
        if (!tchat && !isAdmin) return send(403, { error: 'chat_off' });
        if (other) { if (!teaches(course)) return send(403, { error: 'not_teacher' }); student = other; asT = true; }
        const [er] = await redis(c, [['HGET', P + 'enr:' + course, student]]);
        st = status(parse(er));
        if (!asT && st !== 'a') return send(403, { error: 'not_enrolled', s: st });
        if (asT && !er) return send(404, { error: 'no_student' });
      }
      const tk = P + 'thr:' + course + ':' + student, ik = P + 'thi:' + course;

      if (a === 'thread') {
        const [list, info] = await redis(c, [['LRANGE', tk, -200, -1], ['HGET', ik, student]]);
        const inf = parse(info);
        if (inf && (asT ? inf.ut : inf.us)) { if (asT) inf.ut = 0; else inf.us = 0; await redis(c, [['HSET', ik, student, JSON.stringify(inf)]]); }
        return send(200, { msgs: (list || []).map(parse).filter(Boolean), s: st, student: nameOf(student) });
      }

      if (await limited('msg', 40)) return send(429, { error: 'rate_limit' });
      const text = String(b.text || '').trim().slice(0, 4000);
      const msg = { i: crypto.randomBytes(6).toString('hex'), f: asT ? 't' : 's', n: nameOf(me), t: Date.now() };
      if (asT && ROOMS.indexOf(course) > -1) msg.r = 'dir';
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
      const [info] = await redis(c, [['HGET', ik, student]]);
      const inf = parse(info) || { ut: 0, us: 0 };
      inf.t = msg.t; inf.x = msg.x ? msg.x.slice(0, 80) : '🎤'; if (asT) inf.us = (inf.us || 0) + 1; else inf.ut = (inf.ut || 0) + 1;
      cmds.push(['RPUSH', tk, JSON.stringify(msg)], ['LTRIM', tk, -500, -1], ['HSET', ik, student, JSON.stringify(inf)]);
      await redis(c, cmds);
      return send(200, { ok: true, msg });
    }

    if (!isAdmin) return send(403, { error: 'not_admin' });   // la suite : direction de l'école seulement

    if (a === 'validate' || a === 'refuse') {
      if (CIDS.indexOf(course) < 0) return send(400, { error: 'bad_course' });
      const student = String(b.student || '').toLowerCase();
      const [old] = await redis(c, [['HGET', P + 'enr:' + course, student]]);
      const o = parse(old);
      if (!o) return send(404, { error: 'no_student' });
      const now = Date.now(), msg = { i: crypto.randomBytes(6).toString('hex'), f: 'sys', n: nameOf(me), t: now };
      if (a === 'validate') {
        const months = [1, 2, 3, 6, 12].indexOf(+b.months) > -1 ? +b.months : 1;
        o.s = 'a'; o.until = Math.max(now, o.until || 0) + months * 30 * DAY; o.by = me; o.v = now;
        msg.x = 'ok:' + course + ':' + months + ':' + o.until;
      } else { o.s = 'r'; o.by = me; o.v = now; msg.x = 'refused:' + course; }
      const ik = P + 'thi:dir', [info] = await redis(c, [['HGET', ik, student]]);
      const inf = parse(info) || { ut: 0, us: 0 }; inf.t = now; inf.us = (inf.us || 0) + 1; inf.x = a === 'validate' ? '✅' : '⛔';
      await redis(c, [['HSET', P + 'enr:' + course, student, JSON.stringify(o)], ['RPUSH', P + 'thr:dir:' + student, JSON.stringify(msg)], ['HSET', ik, student, JSON.stringify(inf)]]);
      return send(200, { ok: true, s: status(o), until: o.until || 0 });
    }
    if (a === 'teacher_set') {
      const u = String(b.user || '').trim().toLowerCase();
      if (!(ID_RE.test(u) || EMAIL_RE.test(u))) return send(400, { error: 'bad_id' });
      const cs = (Array.isArray(b.courses) ? b.courses : []).filter(x => CIDS.indexOf(x) > -1);
      if (!cs.length) return send(400, { error: 'no_course' });
      if (!teachers[u] && Object.keys(teachers).length >= MAX_TEACHERS) return send(409, { error: 'max_teachers' });
      const uk = P + 'user:' + u, [exists] = await redis(c, [['EXISTS', uk]]);
      if (!exists) {
        const pw = String(b.password || '');
        if (pw.length < 6 || pw.length > 200) return send(404, { error: 'no_user' });
        const salt = crypto.randomBytes(16), hash = await scrypt(pw, salt);
        await redis(c, [['SET', uk, JSON.stringify({ s: salt.toString('base64'), h: hash.toString('base64'), t: Date.now() }), 'NX']]);
      }
      await redis(c, [['HSET', P + 'teachers', u, JSON.stringify({ courses: cs, t: (teachers[u] && teachers[u].t) || Date.now() })]]);
      return send(200, { ok: true, created: !exists });
    }
    if (a === 'teacher_del') {
      await redis(c, [['HDEL', P + 'teachers', String(b.user || '').toLowerCase()]]);
      return send(200, { ok: true });
    }
    if (a === 'course_save') {
      const id = String(b.id || '');
      const def = COURSES.filter(x => x.id === id)[0];
      if (!def) return send(400, { error: 'bad_course' });
      const price = Math.round(+b.price);
      if (!(price >= 0 && price <= 1000000)) return send(400, { error: 'bad_price' });
      const per = ['mois', 'trimestre', 'an'].indexOf(b.per) > -1 ? b.per : 'mois';
      await redis(c, [['HSET', P + 'courses', id, JSON.stringify({ price, per, active: b.active !== false, sched: cleanSched(b.sched, def.sched) })]]);
      return send(200, { ok: true });
    }
    if (a === 'school_save') {
      await redis(c, [['SET', P + 'school', JSON.stringify(Object.assign(cleanSched(b, SCHOOL), { tchat: b.tchat !== false }))]]);
      return send(200, { ok: true });
    }
    if (a === 'pay_save') {
      const clean = s => String(s || '').replace(/[^\d+ ]/g, '').trim().slice(0, 20);
      await redis(c, [['SET', P + 'payinfo', JSON.stringify({ wave: clean(b.wave), om: clean(b.om), note: String(b.note || '').slice(0, 300) })]]);
      return send(200, { ok: true });
    }
    return send(400, { error: 'bad_action' });
  } catch (err) {
    return send(502, { error: 'storage' });
  }
};
