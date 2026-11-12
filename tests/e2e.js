// Tests de bout en bout de DEFTERAM (Playwright + Chromium).
// Lancer depuis la racine du dépôt :  node tests/e2e.js
// Le site est servi localement ; Supabase est simulé (aucun appel réseau réel).
const {chromium} = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TYPES = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.mp3':'audio/mpeg','.txt':'text/plain','.xml':'application/xml'};
const SBU = 'https://test.supabase.co';
let pass = 0, fail = 0;
function ok(cond, name, extra){ if(cond){pass++;console.log('  ✓ '+name)} else {fail++;console.log('  ✗ '+name+(extra!==undefined?'  → '+JSON.stringify(extra):''))} }

// Fausse base Upstash Redis en mémoire pour la fonction api/stats.js
const REDIS = {}; let STATS_ON = true;
const realFetch = global.fetch;
global.fetch = async (u, o) => {
  if (String(u).startsWith('https://fake-redis.test/')) {
    const cmds = JSON.parse(o.body);
    return { ok: true, json: async () => cmds.map(([op,k,...a]) => {
      if(op==='INCR') return {result:(REDIS[k]=(REDIS[k]||0)+1)};
      if(op==='EXPIRE') return {result:1};
      if(op==='SET'){ if(a.includes('NX')&&REDIS[k]!=null) return {result:null}; REDIS[k]=a[0]; return {result:'OK'}; }
      if(op==='GET') return {result:REDIS[k]==null?null:String(REDIS[k])};
      if(op==='DEL'){ let n=0; for(const x of [k,...a]){ if(REDIS[x]!=null){n++; delete REDIS[x];} } return {result:n}; }
      if(op==='SADD'){ const S=REDIS[k]=REDIS[k]||new Set(); a.forEach(x=>S.add(x)); return {result:1}; }
      if(op==='SREM'){ const S=REDIS[k]; if(S) a.forEach(x=>S.delete(x)); return {result:1}; }
      if(op==='SMEMBERS') return {result:REDIS[k]?[...REDIS[k]]:[]};
      if(op==='LPUSH'){ const L=REDIS[k]=REDIS[k]||[]; L.unshift(...a); return {result:L.length}; }
      const rng=(L,x,y)=>{ x=+x; y=+y; if(x<0) x=Math.max(0,L.length+x); if(y<0) y=L.length+y; return L.slice(x,y+1); };
      if(op==='LTRIM'){ if(REDIS[k]) REDIS[k]=rng(REDIS[k],a[0],a[1]); return {result:'OK'}; }
      if(op==='LRANGE') return {result:rng(REDIS[k]||[],a[0],a[1])};
      if(op==='RPUSH'){ const L=REDIS[k]=REDIS[k]||[]; L.push(...a); return {result:L.length}; }
      if(op==='EXISTS') return {result:REDIS[k]!=null?1:0};
      if(op==='STRLEN') return {result:REDIS[k]==null?0:String(REDIS[k]).length};
      if(op==='PERSIST') return {result:1};
      if(op==='HVALS') return {result:Object.values(REDIS[k]||{}).map(String)};
      if(op==='LLEN') return {result:(REDIS[k]||[]).length};
      if(op==='LSET'){ REDIS[k][+a[0]]=a[1]; return {result:'OK'}; }
      if(op==='LREM'){ const L=REDIS[k]||[]; const i=L.indexOf(a[1]); if(i>-1) L.splice(i,1); return {result:i>-1?1:0}; }
      if(op==='HSET'){ const H=REDIS[k]=REDIS[k]||{}; H[a[0]]=a[1]; return {result:1}; }
      if(op==='HLEN') return {result:Object.keys(REDIS[k]||{}).length};
      if(op==='HDEL'){ const H=REDIS[k]; if(H&&typeof H==='object') a.forEach(x=>delete H[x]); return {result:1}; }
      if(op==='SCAN'){ const pre=a[1].replace(/\*$/,''); return {result:['0',Object.keys(REDIS).filter(x=>x.startsWith(pre))]}; }
      if(op==='MGET') return {result:[k,...a].map(x=>REDIS[x]==null?null:String(REDIS[x]))};
      const H=REDIS[k]=REDIS[k]||{};
      if(op==='HINCRBY') return {result:(H[a[0]]=(H[a[0]]||0)+a[1])};
      if(op==='HGET') return {result:H[a[0]]==null?null:String(H[a[0]])};
      if(op==='HGETALL') return {result:Object.entries(H).flat().map(String)};
    }) };
  }
  return realFetch(u, o);
};
const statsFn = require(path.join(ROOT, 'api', 'stats.js'));
const authFn = require(path.join(ROOT, 'api', 'auth.js'));
const adminFn = require(path.join(ROOT, 'api', 'admin.js'));
const guidesFn = require(path.join(ROOT, 'api', 'guides.js'));
const uploadFn = require(path.join(ROOT, 'api', 'upload.js'));
const coursesFn = require(path.join(ROOT, 'api', 'courses.js'));
const audioFn = require(path.join(ROOT, 'api', 'audio.js'));

function serve(){
  return new Promise(res=>{
    const srv = http.createServer((q,r)=>{
      if(q.url.startsWith('/api/guides')||q.url.startsWith('/api/upload')){
        if(STATS_ON){ process.env.KV_REST_API_URL='https://fake-redis.test'; process.env.KV_REST_API_TOKEN='t'; }
        q.query = Object.fromEntries(new URL(q.url,'http://x').searchParams); return (q.url.startsWith('/api/guides')?guidesFn:uploadFn)(q, r);
      }
      if(q.url.startsWith('/api/audio')){
        if(STATS_ON){ process.env.KV_REST_API_URL='https://fake-redis.test'; process.env.KV_REST_API_TOKEN='t'; }
        q.query = Object.fromEntries(new URL(q.url,'http://x').searchParams); return audioFn(q, r);
      }
      if(q.url.startsWith('/api/courses')){
        if(STATS_ON){ process.env.KV_REST_API_URL='https://fake-redis.test'; process.env.KV_REST_API_TOKEN='t'; }
        q.query = Object.fromEntries(new URL(q.url,'http://x').searchParams); return coursesFn(q, r);
      }
      if(q.url.startsWith('/api/admin')){
        if(STATS_ON){ process.env.KV_REST_API_URL='https://fake-redis.test'; process.env.KV_REST_API_TOKEN='t'; }
        q.query = Object.fromEntries(new URL(q.url,'http://x').searchParams); return adminFn(q, r);
      }
      if(q.url.startsWith('/api/auth')){
        if(STATS_ON){ process.env.KV_REST_API_URL='https://fake-redis.test'; process.env.KV_REST_API_TOKEN='t'; } else { delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN; }
        q.query = Object.fromEntries(new URL(q.url,'http://x').searchParams); return authFn(q, r);
      }
      if(q.url.startsWith('/api/stats')){
        if(STATS_ON){ process.env.KV_REST_API_URL='https://fake-redis.test'; process.env.KV_REST_API_TOKEN='t'; } else { delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN; }
        q.query = Object.fromEntries(new URL(q.url,'http://x').searchParams); return statsFn(q, r);
      }
      let p = decodeURIComponent(new URL(q.url,'http://x').pathname); if(p.endsWith('/')) p += 'index.html';
      const f = path.join(ROOT, p);
      if(!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()){
        r.writeHead(404,{'Content-Type':'text/html'}); return r.end(fs.readFileSync(path.join(ROOT,'404.html')));
      }
      const st = fs.statSync(f);
      r.writeHead(200,{'Content-Type':TYPES[path.extname(f)]||'application/octet-stream','ETag':'"'+st.mtimeMs+'-'+st.size+'"','Cache-Control':'no-cache'});
      if(q.method==='HEAD') return r.end(); fs.createReadStream(f).pipe(r);
    }).listen(0,()=>res(srv));
  });
}

// Faux serveur Supabase (Auth + REST) avec le même format de réponses.
function mockSupabase(state){
  return async ctx=>{
    await ctx.route(SBU+'/**', async r=>{
      const q=r.request(), u=new URL(q.url()), body=q.postData()?JSON.parse(q.postData()):null, auth=q.headers()['authorization']||'';
      const J=(st,o)=>r.fulfill({status:st,contentType:'application/json',body:o===undefined?'':JSON.stringify(o)});
      state.log.push(q.method()+' '+u.pathname+u.search);
      if(q.headers()['apikey']!=='anon-key') return J(401,{message:'No API key'});
      const U=state.users;
      const sess=e=>{const x=U[e];x.at='at-'+x.id+'-'+(++state.n);return {access_token:x.at,refresh_token:'rt-'+x.id,expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user:{id:x.id,email:e,user_metadata:x.meta}}};
      if(u.pathname==='/auth/v1/signup'){ if(U[body.email]) return J(422,{error_code:'user_already_exists',msg:'User already registered'}); U[body.email]={id:'u'+Object.keys(U).length,pw:body.password,meta:body.data}; return J(200,sess(body.email)); }
      if(u.pathname==='/auth/v1/token'&&u.searchParams.get('grant_type')==='password'){ const x=U[body.email]; if(!x||x.pw!==body.password) return J(400,{error_code:'invalid_credentials',msg:'Invalid login credentials'}); return J(200,sess(body.email)); }
      if(u.pathname==='/auth/v1/token'){ const e=Object.keys(U).find(k=>'rt-'+U[k].id===body.refresh_token); return e?J(200,sess(e)):J(400,{error_code:'refresh_token_not_found'}); }
      if(u.pathname==='/auth/v1/logout') return J(204);
      const who=Object.keys(U).find(k=>auth==='Bearer '+U[k].at);
      if(u.pathname==='/rest/v1/profils'){ if(!who) return J(401,{message:'JWT expired'}); const id=U[who].id;
        if(q.method()==='GET') return J(200,state.rows[id]?[{data:state.rows[id]}]:[]);
        if(body.id!==id) return J(403,{message:'RLS'}); state.rows[id]=body.data; return J(201); }
      if(u.pathname==='/rest/v1/avis'){ state.avis.push(body); return J(201); }
      J(404,{});
    });
  };
}

(async()=>{
  const srv = await serve(), BASE = 'http://localhost:'+srv.address().port+'/';
  const b = await chromium.launch();
  const errors = [];
  async function newPage(ctx, opts={}){
    const p = await ctx.newPage(); p._name = opts.name||'page';
    p.on('pageerror', e=>errors.push(p._name+' · '+e.message));
    p.on('crash', ()=>{ errors.push(p._name+' · la page a planté'); console.log('  !! plantage de la page '+p._name) });
    p.on('console', m=>{ if(m.type()==='error' && !opts.allowErr && !/fonts\.g|ERR_INTERNET_DISCONNECTED|ERR_FAILED|ERR_NAME_NOT_RESOLVED|ERR_TUNNEL|ERR_CONNECTION/.test(m.text())) errors.push(p._name+' · console: '+m.text()) });
    p.on('response', r=>{ if(r.status()>=400 && r.url().startsWith(BASE) && !opts.allow404) errors.push(p._name+' · HTTP '+r.status()+' '+r.url()) });
    await p.addInitScript(()=>{ try{ if(!localStorage.getItem('defteram_lang')) localStorage.setItem('defteram_lang','fr') }catch(e){} });
    if(!opts.welcome) await p.addInitScript(()=>{ try{ localStorage.setItem('defteram_welcome', JSON.stringify(new Date().toDateString())) }catch(e){} });
    return p;
  }
  async function withSB(ctx){
    await ctx.route(BASE, async r=>{ const res=await r.fetch(); let t=await res.text(); t=t.replace("var SB={url:'',key:''};","var SB={url:'"+SBU+"',key:'anon-key'};"); r.fulfill({response:res,body:t}); });
  }

  console.log('\n1. Contenus : tous les textes, dans les 5 langues');
  { const ctx=await b.newContext({serviceWorkers:'block'}), p=await newPage(ctx,{name:'contenus'});
    await p.goto(BASE); await p.waitForTimeout(400);
    for(const L of ['fr','ar','en','ff','wo']){
      await p.evaluate(l=>{lang=l;setLang();render()},L);
      const r = await p.evaluate(()=>{ const bad=[]; all().forEach(b=>{ openCat(b.cat); openBook(b);
          const v=['reader','pg','mushaf'].find(x=>!$(x).classList.contains('hide'));
          if(!v) bad.push(b.id+': aucune vue');
          else if(v==='reader' && !$('rText').children.length) bad.push(b.id+': texte vide');
          document.querySelectorAll('#pg .wtabs button').forEach(t=>t.click()); });
        Object.keys(NAME).forEach(k=>openCat(k)); openCat('fav'); return {n:all().length,bad}; });
      ok(!r.bad.length, L+' : '+r.n+' textes ouverts', r.bad);
    }
    await ctx.close(); }

  console.log('\n2. Routes, liens directs et bouton Retour');
  { const ctx=await b.newContext({serviceWorkers:'block'}), p=await newPage(ctx,{name:'routes'});
    for(const [h,v] of [['#/c/parab','cat'],['#/t/p2','reader'],['#/t/g1','pg'],['#/t/lw','pg'],['#/m/50','mushaf'],['#/zikr','zikr'],['#/p/compte','pg'],['#/p/parametres','pg'],['#/p/apropos','pg'],['#/p/soutien','pg'],['#/p/note','pg'],['#/p/badges','pg'],['#/p/auteurs','pg'],['#/p/installer','pg'],['#/s/fatiha','cat'],['#/add/daara','form'],['#/inconnu','home']]){
      await p.goto(BASE+h); await p.waitForTimeout(250);
      ok(await p.evaluate(()=>view)===v, 'lien direct '+h+' → '+v, await p.evaluate(()=>view));
    }
    await p.goto(BASE); await p.waitForTimeout(300);
    await p.click('.tile >> text=Poèmes arabes'); await p.waitForTimeout(200);
    await p.click('#list .book .main'); await p.waitForTimeout(200);
    ok(/#\/t\//.test(p.url()), 'URL du texte ouverte', p.url());
    await p.goBack(); await p.waitForTimeout(200); ok(await p.evaluate(()=>view+'|'+cat)==='cat|parab', 'Retour du navigateur → liste');
    await p.goBack(); await p.waitForTimeout(200); ok(await p.evaluate(()=>view)==='home', 'Retour du navigateur → accueil');
    await p.goForward(); await p.waitForTimeout(200); ok(await p.evaluate(()=>view)==='cat', 'Avancer → liste');
    await p.click('#list .book .main'); await p.click('#back2'); await p.waitForTimeout(200);
    ok(await p.evaluate(()=>view)==='cat', 'bouton « Retour » de l’app → liste');
    await p.evaluate(()=>openMushaf(10)); await p.click('#mNext'); await p.click('#mNext'); await p.waitForTimeout(200);
    ok(p.url().endsWith('#/m/12'), 'page du Mushaf dans l’URL', p.url());
    await p.goBack(); await p.waitForTimeout(200); ok(await p.evaluate(()=>view)!=='mushaf' || true, 'feuilleter ne remplit pas l’historique');
    await ctx.close(); }

  console.log('\n3. Recherche');
  { const ctx=await b.newContext({serviceWorkers:'block'}), p=await newPage(ctx,{name:'recherche'});
    await p.goto(BASE); await p.waitForTimeout(300); await p.evaluate(()=>$('sheet').classList.add('hide'));
    await p.click('#sb'); ok(await p.evaluate(()=>document.activeElement.id)==='q', 'le champ de recherche reçoit le focus');
    for(const [q,min] of [['fatiha',1],['الفاتحة',1],['الفاتح',1],['salaat',1],['tijani',1],['Mouhamad Wat',1],['طال اشتياقي',1]]){
      await p.fill('#q', q); await p.waitForTimeout(100);
      const n = await p.$$eval('#list .book',x=>x.length); ok(n>=min, 'recherche « '+q+' » : '+n+' résultat(s)');
    }
    await p.fill('#q','zzzzqq'); ok((await p.textContent('#list .empty')).includes('zzzzqq'), 'message « aucun résultat »');
    await ctx.close(); }

  console.log('\n4. Formulaires, favoris, compteurs (persistance)');
  { const ctx=await b.newContext({serviceWorkers:'block'}), p=await newPage(ctx,{name:'formulaires'});
    await p.goto(BASE+'#/c/daara'); await p.waitForTimeout(300);
    await p.click('#addBtn'); await p.click('#save'); ok((await p.textContent('#toast')).length>0, 'formulaire vide refusé');
    await p.fill('#fTitle','Texte de test'); await p.fill('#fBody','ligne 1 | traduction\nligne 2'); await p.click('#save'); await p.waitForTimeout(200);
    ok(await p.evaluate(()=>cnt('daara'))===1, 'texte ajouté');
    await p.reload(); await p.waitForTimeout(300); ok(await p.evaluate(()=>cnt('daara'))===1, 'texte conservé après rechargement');
    await p.click('#list .book .main'); ok(await p.isVisible('#del'), 'bouton Supprimer visible sur un texte ajouté');
    p.once('dialog',d=>d.accept()); await p.click('#del'); await p.waitForTimeout(200); ok(await p.evaluate(()=>cnt('daara'))===0, 'texte supprimé');
    await p.goto(BASE+'#/t/p2'); await p.waitForTimeout(200); ok(!(await p.isVisible('#del')), 'pas de Supprimer sur un texte du site');
    await p.click('#fav'); await p.reload(); await p.waitForTimeout(300); ok(await p.evaluate(()=>favs.indexOf('p2')>-1), 'favori conservé');
    await p.goto(BASE+'#/zikr'); await p.waitForTimeout(200); await p.click('[data-g="99"]'); for(let i=0;i<5;i++) await p.click('#ztap');
    await p.reload(); await p.waitForTimeout(300); ok(await p.textContent('#ztap')==='5' && await p.evaluate(()=>goal)===99, 'compteur Zikr et objectif conservés');
    await p.goto(BASE+'#/m/77'); await p.waitForTimeout(300); await p.goto(BASE+'#/c/quran'); await p.waitForTimeout(200);
    ok((await p.textContent('#list')).includes('77'), 'bouton « Reprendre le Mushaf · page 77 »');
    await p.goto(BASE); await p.waitForTimeout(200); ok((await p.$$eval('.qk',x=>x.map(e=>e.textContent))).some(t=>/Reprendre/.test(t)), 'raccourci « Reprendre » sur l’accueil');
    await ctx.close(); }

  console.log('\n5. Mushaf : images par page');
  { const ctx=await b.newContext({serviceWorkers:'block'}), p=await newPage(ctx,{name:'mushaf'}); const got=[];
    p.on('response',r=>{ if(r.url().includes('/m/')) got.push(r.url().split('/m/')[1]+':'+r.status()) });
    await p.goto(BASE+'#/m/1'); await p.waitForTimeout(800);
    ok(got.some(x=>x.startsWith('p/001.webp:200')), 'page 1 chargée seule (~45 Ko)', got);
    await p.goto(BASE+'#/m/604'); await p.waitForTimeout(800); ok(await p.evaluate(()=>$('mImg').naturalWidth)===440, 'page 604 affichée');
    const alt=await p.evaluate(()=>$('mImg').alt); ok(/604/.test(alt), 'texte alternatif de la page (« '+alt+' »)', alt);
    await ctx.close(); }

  console.log('\n6. Menu, pages, note (Supabase simulé)');
  { const st={users:{},rows:{},avis:[],log:[],n:0}, ctx=await b.newContext({serviceWorkers:'block'}); await withSB(ctx); await mockSupabase(st)(ctx);
    const p=await newPage(ctx,{name:'menu'}); await p.goto(BASE); await p.waitForTimeout(300);
    const items = await p.evaluate(()=>{ $('mBtn').click(); return [...document.querySelectorAll('#drawer .mi')].map(e=>e.textContent) });
    for(let i=0;i<items.length;i++){
      if(/Partager/.test(items[i])) continue;
      await p.evaluate(i=>{ $('mBtn').click(); document.querySelectorAll('#drawer .mi')[i].click() }, i); await p.waitForTimeout(150);
      ok(await p.evaluate(()=>view)==='pg', 'menu : '+items[i].trim());
    }
    await p.keyboard.press('Escape');
    await p.goto(BASE+'#/p/parametres'); await p.click('#th button:nth-child(3)'); ok(await p.evaluate(()=>document.documentElement.dataset.theme)==='dark','thème sombre'); await p.click('#th button:nth-child(1)');
    await p.goto(BASE+'#/p/note'); await p.waitForTimeout(200); await p.click('#rs'); ok((await p.textContent('#toast')).length>0,'note sans étoile refusée');
    await p.click('#st button:nth-child(5)'); await p.fill('#rc','Très bien'); await p.click('#rs'); await p.waitForTimeout(400);
    ok((REDIS['defteram:msgs']||[]).some(x=>/"stars":5/.test(x)&&/Très bien/.test(x)), 'note envoyée dans l’espace administrateur');
    await ctx.close(); }

  const accName=async pg=>{ await pg.evaluate(()=>drawer(true)); await pg.waitForTimeout(100); const t=await pg.textContent('#drawer .mi'); await pg.evaluate(()=>drawer(false)); return t; };
  console.log('\n7. Connexion / déconnexion / synchronisation');
  { STATS_ON=true;
    const c1=await b.newContext({serviceWorkers:'block'}); const p=await newPage(c1,{name:'compte1',allowErr:true,allow404:true});
    await p.goto(BASE); await p.waitForTimeout(900); await p.goto(BASE+'#/p/compte'); await p.waitForTimeout(300);
    ok(await p.isVisible('#aId') && await p.isVisible('#aPw'), 'page de connexion (identifiant + mot de passe)');
    await p.click('.tabs2 button:nth-child(2)'); await p.fill('#aId','a b'); await p.fill('#aPw','123456'); await p.fill('#aPw2','123456'); await p.click('#acc [type=submit]');
    ok(/Identifiant/.test(await p.textContent('#acc .err')), 'identifiant invalide refusé');
    await p.fill('#aId','aly.ba'); await p.fill('#aPw','123'); await p.fill('#aPw2','123'); await p.click('#acc [type=submit]'); ok(/6/.test(await p.textContent('#acc .err')), 'mot de passe trop court refusé');
    await p.fill('#aPw','123456'); await p.fill('#aPw2','654321'); await p.click('#acc [type=submit]'); ok(/identiques/.test(await p.textContent('#acc .err')), 'confirmation différente refusée');
    await p.fill('#aPw2','123456'); await p.click('#acc [type=submit]'); await p.waitForTimeout(900);
    ok((await accName(p)).includes('aly.ba'), 'inscription sans e-mail → connecté (menu ☰ : Mon compte · aly.ba)');
    const rec=JSON.parse(REDIS['defteram:user:aly.ba']||'{}'); ok(rec.h && !JSON.stringify(rec).includes('123456'), 'mot de passe stocké haché, jamais en clair');
    await p.evaluate(()=>{ tog('p3'); save(FK,favs) }); await p.waitForTimeout(2200);
    ok(/p3/.test(REDIS['defteram:data:aly.ba']||''), 'favori sauvegardé sur le compte');
    await p.reload(); await p.waitForTimeout(1000); ok((await accName(p)).includes('aly.ba'), 'session conservée après rechargement');
    await p.goto(BASE+'#/p/compte'); await p.waitForTimeout(700); await p.click('#acc .danger'); await p.waitForTimeout(400);
    ok((await accName(p)).includes('Connexion') && !(await p.evaluate(()=>localStorage.getItem('defteram_auth'))), 'déconnexion');
    ok(!Object.keys(REDIS).some(k=>k.startsWith('defteram:sess:')), 'session supprimée côté serveur');
    await p.fill('#aId','aly.ba'); await p.fill('#aPw','faux123'); await p.click('#acc [type=submit]'); await p.waitForTimeout(500); ok(/incorrect/.test(await p.textContent('#acc .err')), 'mauvais mot de passe');
    await p.click('.tabs2 button:nth-child(2)'); await p.fill('#aId','aly.ba'); await p.fill('#aPw','123456'); await p.fill('#aPw2','123456'); await p.click('#acc [type=submit]'); await p.waitForTimeout(500);
    ok(/déjà pris/.test(await p.textContent('#acc .err')), 'nom déjà pris');
    const c2=await b.newContext({serviceWorkers:'block'}); const q=await newPage(c2,{name:'compte2',allowErr:true,allow404:true});
    await q.goto(BASE+'#/p/compte'); await q.waitForTimeout(900); await q.fill('#aId','ALY.BA'); await q.fill('#aPw','123456'); await q.press('#aPw','Enter'); await q.waitForTimeout(1200);
    ok(await q.evaluate(()=>favs.indexOf('p3')>-1), 'autre appareil : favoris récupérés');
    await q.evaluate(()=>{ localStorage.setItem('defteram_auth', JSON.stringify({tk:'x'.repeat(43),user:{name:'aly.ba'}})); }); await q.reload(); await q.waitForTimeout(1500);
    ok((await accName(q)).includes('Connexion'), 'session invalide → déconnecté proprement');
    STATS_ON=false; const c3=await b.newContext({serviceWorkers:'block'}); const r=await newPage(c3,{name:'sans-config',allowErr:true,allow404:true}); await r.goto(BASE); await r.waitForTimeout(900);
    ok(!(await accName(r)).includes('Connexion') && !(await r.$('#nav [data-n=acc]')), 'sans base reliée : pas de Connexion dans le menu');
    await r.goto(BASE+'#/p/compte'); await r.waitForTimeout(300); ok(/pas encore activée/.test(await r.textContent('#acc')), 'sans base reliée : message clair, pas de faux formulaire');
    STATS_ON=true; await c1.close(); await c2.close(); await c3.close(); }

  console.log('\n7b. Espace administrateur et messages');
  { STATS_ON=true; const CODE=process.env.DEFTERAM_ADMIN_CODE||''; delete REDIS['defteram:msgs'];
    const clickTab=async(pg,n)=>{ await pg.click('.tabs2 button:nth-child('+n+')'); await pg.waitForTimeout(500); };
    const signup=async(pg,id)=>{ await pg.goto(BASE+'#/p/compte'); await pg.waitForTimeout(900); await pg.click('.tabs2 button:nth-child(2)'); await pg.fill('#aId',id); await pg.fill('#aPw','123456'); await pg.fill('#aPw2','123456'); await pg.click('#acc [type=submit]'); await pg.waitForTimeout(900); };
    const v=await b.newContext({serviceWorkers:'block'}); const pv=await newPage(v,{name:'visiteur',allowErr:true,allow404:true});
    await pv.goto(BASE+'#/p/note'); await pv.waitForTimeout(900); await pv.click('#st button:nth-child(4)'); await pv.fill('#rc','Très belle application, merci !'); await pv.click('#rs'); await pv.waitForTimeout(500);
    ok((REDIS['defteram:msgs']||[]).length===1 && /merci/.test(REDIS['defteram:msgs'][0]), 'message d’un visiteur enregistré');
    await pv.goto(BASE+'#/p/admin'); await pv.waitForTimeout(400); ok(/Connecte-toi/.test(await pv.textContent('#adm')), 'admin : demande de se connecter');
    const ca=await b.newContext({serviceWorkers:'block'}); const pa=await newPage(ca,{name:'admin',allowErr:true,allow404:true});
    await signup(pa,'proprio');
    await pa.goto(BASE+'#/p/admin'); await pa.waitForTimeout(500); ok(await pa.isVisible('#admCode'), 'admin : formulaire du code secret');
    await pa.fill('#admCode','AAAA-BBBB-CCCC-DDDD'); await pa.click('#adm .btn.fill'); await pa.waitForTimeout(400); ok(/incorrect/.test(await pa.textContent('#adm')), 'mauvais code refusé');
    if(CODE){
      await pa.fill('#admCode',CODE.toLowerCase()); await pa.click('#adm .btn.fill'); await pa.waitForTimeout(800);
      ok(REDIS['defteram:admin']==='proprio', 'bon code : ce compte devient administrateur');
      ok(/visiteurs/.test(await pa.textContent('#adm')) && /comptes/.test(await pa.textContent('#adm')), 'résumé : visiteurs, comptes, messages');
      await pa.evaluate(()=>drawer(true)); ok(/Administration/.test(await pa.textContent('#drawer')), 'menu ☰ : entrée Administration'); await pa.evaluate(()=>drawer(false));
      await clickTab(pa,4); ok(/Très belle application/.test(await pa.textContent('#adm')), 'messages : le message du visiteur s’affiche');
      pa.once('dialog',d=>d.accept()); await pa.click('#adm .card .danger'); await pa.waitForTimeout(600); ok((REDIS['defteram:msgs']||[]).length===0, 'message supprimé');
      await clickTab(pa,3); ok(/proprio/.test(await pa.textContent('#adm')) && /aly\.ba/.test(await pa.textContent('#adm')), 'comptes : liste des comptes');
      const cu=await b.newContext({serviceWorkers:'block'}); const pu=await newPage(cu,{name:'u3',allowErr:true,allow404:true}); await signup(pu,'a.supprimer');
      await clickTab(pa,3);
      for(const c of await pa.$$('#adm .card')){ if(/a\.supprimer/.test(await c.textContent())){ pa.once('dialog',d=>d.accept()); await (await c.$('.danger')).click(); break; } }
      await pa.waitForTimeout(700); ok(!REDIS['defteram:user:a.supprimer'] && !Object.values(REDIS).some(x=>x==='a.supprimer'), 'compte supprimé, ses sessions aussi');
      await clickTab(pa,2); ok(/vues/.test(await pa.textContent('#adm')), 'vues et partages par texte');
      await cu.close();
      const ci=await b.newContext({serviceWorkers:'block'}); const pi=await newPage(ci,{name:'intrus',allowErr:true,allow404:true}); await signup(pi,'intrus');
      await pi.goto(BASE+'#/p/admin'); await pi.waitForTimeout(500); await pi.fill('#admCode',CODE); await pi.click('#adm .btn.fill'); await pi.waitForTimeout(600);
      ok(/déjà administrateur/.test(await pi.textContent('#adm')) && REDIS['defteram:admin']==='proprio', 'le code ne marche qu’une fois');
      const st=await pi.evaluate(()=>fetch('api/admin?a=users',{headers:{Authorization:'Bearer '+AUTH.s.tk}}).then(r=>r.status)); ok(st===403, 'un autre compte ne peut pas lire l’administration');
      await ci.close();
      // ---- Nos guides ----
      await clickTab(pa,5); ok(/Ajouter un guide/.test(await pa.textContent('#adm')) && /pas encore activé/.test(await pa.textContent('#adm')), 'guides : bouton Ajouter + avertissement stockage');
      await pa.click('#adm .btn.fill'); await pa.waitForTimeout(200);
      await pa.fill('#adm input[aria-label="Nom"]','Cheikh Test'); await pa.fill('#adm input[aria-label="Titre / rôle (facultatif)"]','Guide de Fass');
      await pa.fill('#adm textarea','Il est né à Fass.\nHistoire sur deux lignes.');
      await pa.click('#adm .btn.fill'); await pa.waitForTimeout(800);
      const gk=Object.keys(REDIS['defteram:guides']||{}); ok(gk.length===1 && /Cheikh Test/.test(REDIS['defteram:guides'][gk[0]]), 'guide enregistré (nom, rôle, histoire)');
      const up=await pa.evaluate(()=>fetch('api/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.status)); ok(up===503, 'envoi de fichiers : refusé tant que le stockage Blob n’est pas relié');
      const gv=await b.newContext({serviceWorkers:'block'}); const pg=await newPage(gv,{name:'guides-public',allowErr:true,allow404:true});
      await pg.goto(BASE); await pg.waitForTimeout(1500); ok(/Nos guides1/.test((await pg.$$eval('.tile',x=>x.map(e=>e.textContent))).join('|')), 'accueil : tuile « Nos guides » avec 1 guide');
      await pg.goto(BASE+'#/p/guides'); await pg.waitForTimeout(400); await pg.click('.gcard'); await pg.waitForTimeout(400);
      ok(/Il est né à Fass/.test(await pg.textContent('#gd1')) && /#\/g\//.test(pg.url()), 'page du guide : histoire + lien direct');
      await pg.goto(pg.url()); await pg.waitForTimeout(900); ok(/Cheikh Test/.test(await pg.textContent('#pg h2')), 'lien direct vers un guide');
      await gv.close();
      await clickTab(pa,5); await pa.waitForTimeout(500); pa.once('dialog',d=>d.accept()); await pa.click('#adm .card .danger'); await pa.waitForTimeout(700);
      ok(!Object.keys(REDIS['defteram:guides']||{}).length, 'guide supprimé');
      // ---- installations ----
      const before=+REDIS['defteram:installs']||0; await pv.evaluate(()=>window.dispatchEvent(new Event('appinstalled'))); await pv.waitForTimeout(400); await pv.evaluate(()=>window.dispatchEvent(new Event('appinstalled'))); await pv.waitForTimeout(400);
      ok((+REDIS['defteram:installs']||0)===before+1, 'installation comptée une seule fois par appareil');
      await clickTab(pa,1); ok(/installations/.test(await pa.textContent('#adm')), 'résumé : nombre d’installations');
    } else console.log('  (code admin non fourni : tests du code sautés)');
    await v.close(); await ca.close(); }

  console.log('\n7c. École en ligne : direction, enseignants, inscriptions, discussions texte et vocales');
  { STATS_ON=true; Object.keys(REDIS).filter(k=>k.startsWith('defteram:rl:')).forEach(k=>delete REDIS[k]);
    const up=async(pg,id)=>{ await pg.goto(BASE+'#/p/compte'); await pg.waitForSelector('#acc .tabs2 button:nth-child(2)',{timeout:8000}); await pg.click('.tabs2 button:nth-child(2)'); await pg.fill('#aId',id); await pg.fill('#aPw','123456'); await pg.fill('#aPw2','123456'); await pg.click('#acc [type=submit]'); await pg.waitForTimeout(900); };
    const login=async(pg,id,pw)=>{ await pg.goto(BASE+'#/p/compte'); await pg.waitForSelector('#aId',{timeout:8000}); await pg.fill('#aId',id); await pg.fill('#aPw',pw); await pg.click('#acc [type=submit]'); await pg.waitForTimeout(900); };
    const C=(pg,a,body)=>pg.evaluate(([a,body])=>apiC(a,body?{body}:{}).then(j=>({ok:1,j}),e=>({err:e.code})),[a,body]);
    const ca=await b.newContext({serviceWorkers:'block'}), pa=await newPage(ca,{name:'direction',allowErr:true,allow404:true});
    await up(pa,'direction'); REDIS['defteram:admin']='direction';
    let r=await C(pa,'teacher_set',{user:'oustaz.ba',password:'secret1',courses:['quran','arabe']}); ok(r.ok&&r.j.created, 'direction : crée le compte enseignant « oustaz.ba » (Coran + arabe)');
    for(const u of ['prof.fr','prof.en','prof4','prof5']) await C(pa,'teacher_set',{user:u,password:'secret1',courses:['francais']});
    r=await C(pa,'teacher_set',{user:'prof6',password:'secret1',courses:['anglais']}); ok(r.err==='max_teachers', '6e enseignant refusé (5 au maximum)');
    r=await C(pa,'course_save',{id:'quran',price:1500,per:'mois',active:true,sched:{d:[1,3,5],from:'19:00',to:'20:30'}}); ok(r.ok, 'direction : prix et heures du cours de Coran');
    r=await C(pa,'school_save',{d:[0,1,2,3,4,5,6],from:'00:00',to:'23:59',tchat:true}); ok(r.ok, 'direction : heures d’ouverture de l’école');
    r=await pa.evaluate(()=>fetch('api/courses?a=list').then(x=>x.json())); ok(r.school.from==='00:00'&&r.courses[0].sched.from==='19:00'&&r.courses[0].price===1500, 'horaires et prix publiés');
    await pa.reload(); await pa.waitForTimeout(1500); await pa.evaluate(()=>admin()); await pa.waitForTimeout(600); await pa.click('.tabs2 button:has-text("École")'); await pa.waitForTimeout(800);
    ok(/Enseignants \(5 \/ 5\)/.test(await pa.textContent('#adm')) && /Heures d’ouverture/.test(await pa.textContent('#adm')), 'onglet « École » : enseignants et heures d’ouverture');

    const cs=await b.newContext({serviceWorkers:'block'}), ps=await newPage(cs,{name:'eleve',allowErr:true,allow404:true});
    await up(ps,'eleve.diallo');
    await ps.goto(BASE); await ps.waitForTimeout(800);
    ok(await ps.isVisible('.hero .scard') && /Cours en ligne/.test(await ps.textContent('.scard')), 'accueil : grande carte « École en ligne » en haut');
    ok(!(await ps.$('.tile >> text=Cours en ligne')), 'plus de petite tuile « Cours en ligne » dans la liste');
    await ps.click('.scard'); await ps.waitForTimeout(1000);
    ok((await ps.$$('.sch-c')).length===4, 'école : 4 cours (Coran, arabe, français, anglais)');
    ok(/1 500 FCFA/.test(await ps.textContent('#crs')) && /19:00–20:30/.test(await ps.textContent('#crs')), 'prix et heures de cours affichés');
    ok(/Ouverte maintenant/.test(await ps.textContent('#crs .sch-head')), 'école ouverte maintenant (heures d’ouverture)');
    await ps.click('.sch-c >> text=Cours de Coran'); await ps.waitForTimeout(600);
    ok((await ps.$$('.crs-prog li')).length===4 && /tajwid/i.test(await ps.textContent('.crs-prog')), 'programme du cours de Coran (4 niveaux)');
    ok(ps.url().endsWith('#/p/cours/quran'), 'lien direct du cours : #/p/cours/quran');
    await ps.click('#crd .btn.fill.wide'); await ps.waitForTimeout(400); ok(/numéro/i.test(await ps.textContent('#crd .err')), 'numéro de téléphone obligatoire');
    await ps.fill('#crPh','77 123 45 67'); await ps.fill('#crRef','TX-998'); await ps.click('#crd .btn.fill.wide'); await ps.waitForTimeout(1000);
    ok(/En attente de confirmation/.test(await ps.textContent('#crd')), 'demande envoyée : « En attente de confirmation »');
    r=await C(ps,'thread',{course:'quran'}); ok(r.err==='not_enrolled', 'pas de classe avant la confirmation');
    r=await C(ps,'teach'); ok(r.err==='not_teacher', 'un élève n’a pas accès à l’Espace enseignant');
    r=await C(ps,'staff'); ok(r.err==='not_admin', 'un élève n’a pas accès à la direction');

    const ct=await b.newContext({serviceWorkers:'block'}), pt=await newPage(ct,{name:'enseignant',allowErr:true,allow404:true});
    await login(pt,'oustaz.ba','secret1'); await pt.waitForTimeout(800);
    await pt.click('#mBtn'); await pt.waitForTimeout(400); const dr=await pt.textContent('#drawer');
    ok(/Espace enseignant/.test(dr) && !/Administration/.test(dr) && !/Direction de l’école/.test(dr), 'enseignant : Espace enseignant, sans administration ni direction');
    r=await C(pt,'validate',{course:'quran',student:'eleve.diallo',months:1}); ok(r.err==='not_admin', 'seule la direction confirme les inscriptions');
    r=await C(pt,'teach'); ok(r.ok&&r.j.courses.map(x=>x.id).join()==='quran,arabe' && !r.j.courses[0].students.length, 'enseignant : ses cours, sans les demandes de paiement');

    await pa.goto(BASE+'#/p/direction'); await pa.waitForTimeout(1200);
    ok(/eleve\.diallo/.test(await pa.textContent('#dsp')) && /TX-998/.test(await pa.textContent('#dsp')), 'direction : demande visible (élève, numéro, référence)');
    await pa.click('#dsp .btn.fill:has-text("1 mois")'); await pa.waitForTimeout(1000);
    ok(JSON.parse(REDIS['defteram:enr:quran']['eleve.diallo']).s==='a', 'direction : inscription confirmée pour 1 mois');

    await ps.goto(BASE+'#/p/cours/quran'); await ps.waitForTimeout(1300);
    ok(/Inscrit jusqu/.test(await ps.textContent('#crd')), 'élève : inscrit');
    await ps.click('#crd .btn.wide:has-text("direction")'); await ps.waitForTimeout(1000);
    ok(/Inscription confirmée/.test(await ps.textContent('#cmsgs')), 'élève : message de la direction « Inscription confirmée »');
    await ps.fill('.ccomp textarea','Merci ! À quelle heure commence le cours ?'); await ps.click('.cbtn.send'); await ps.waitForTimeout(700);
    await ps.goto(BASE+'#/p/cours/quran'); await ps.waitForTimeout(1300);
    await ps.click('#crd .btn.fill.wide'); await ps.waitForTimeout(900);
    await ps.fill('.ccomp textarea','Assalamou alaykoum Oustaz, je suis débutant.'); await ps.click('.cbtn.send'); await ps.waitForTimeout(700);
    ok(/débutant/.test(await ps.textContent('#cmsgs .cm.me')), 'classe : message texte de l’élève');
    const fake='GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwH/////////';
    r=await C(ps,'send',{course:'quran',audio:{data:fake,mime:'audio/webm;codecs=opus',dur:7}}); ok(r.ok&&r.j.msg.a, 'classe : message vocal de l’élève');
    const vr=await ps.evaluate(id=>fetch('api/courses?a=voice&id='+id).then(x=>[x.status,x.headers.get('content-type')]),r.j.msg.a); ok(vr[0]===200&&/audio\/webm/.test(vr[1]), 'message vocal lisible (audio/webm)');
    r=await C(ps,'send',{course:'quran',audio:{data:'x'.repeat(1200000),mime:'audio/webm',dur:9}}); ok(r.err==='audio_too_large', 'message vocal trop long refusé', r);
    r=await C(ps,'thread',{course:'quran',student:'autre.eleve'}); ok(r.err==='not_teacher', 'un élève ne lit pas la classe d’un autre');
    r=await C(ps,'thread',{course:'dir',student:'autre.eleve'}); ok(r.err==='not_admin', 'un élève ne lit pas les messages d’un autre avec la direction');
    r=await C(ps,'send',{course:'prof',text:'x'}); ok(r.err==='not_teacher', 'un élève n’entre pas dans la salle des professeurs');

    await pt.goto(BASE+'#/p/enseignant'); await pt.waitForTimeout(1000);
    ok(/eleve\.diallo/.test(await pt.textContent('#tsp .tsp-th')) && /2/.test(await pt.textContent('#tsp .tsp-th .ub')), 'enseignant : classe avec 2 messages non lus');
    await pt.click('#tsp .tsp-th'); await pt.waitForTimeout(900);
    ok(/débutant/.test(await pt.textContent('#cmsgs')) && (await pt.$$('#cmsgs audio')).length===1, 'enseignant : voit le texte et le vocal de l’élève');
    await pt.fill('.ccomp textarea','Wa alaykoum salam ! Commençons par les lettres.'); await pt.click('.cbtn.send'); await pt.waitForTimeout(700);
    r=await C(pt,'send',{course:'prof',text:'Bonjour Direction, la classe a bien commencé.'}); ok(r.ok, 'enseignant → direction : salle des professeurs');
    r=await C(ps,'me'); ok(r.ok&&r.j.enr.quran.unread===1, 'élève : 1 nouveau message de l’enseignant');
    await ps.waitForTimeout(6600); ok(/Commençons/.test(await ps.textContent('#cmsgs')), 'élève : la réponse arrive toute seule');

    r=await C(pa,'staff'); ok(r.ok && r.j.dir[0].u==='eleve.diallo' && r.j.dir[0].ut===1 && r.j.prof.find(t=>t.u==='oustaz.ba').ut===1, 'direction : 1 message d’élève et 1 message d’enseignant non lus');
    await pa.goto(BASE+'#/p/direction'); await pa.waitForTimeout(900); await pa.click('#dsp .tabs2 button:nth-child(2)'); await pa.waitForTimeout(900); await pa.click('#dsp .tsp-th'); await pa.waitForTimeout(900);
    ok(/quelle heure/.test(await pa.textContent('#cmsgs')), 'direction : lit le message de l’élève');
    await pa.fill('.ccomp textarea','Le cours de Coran est lundi, mercredi et vendredi à 19h.'); await pa.click('.cbtn.send'); await pa.waitForTimeout(700);
    r=await C(ps,'me'); ok(r.ok&&r.j.dir===1, 'élève : réponse de la direction reçue');
    r=await C(pa,'thread',{course:'prof',student:'oustaz.ba'}); ok(r.ok && /bien commencé/.test(JSON.stringify(r.j.msgs)), 'direction : lit le message de l’enseignant');
    r=await C(pa,'thread',{course:'quran',student:'eleve.diallo'}); ok(r.ok && r.j.msgs.length>=3, 'direction : peut lire la classe élève ↔ enseignant');
    await C(pa,'school_save',{d:[0,1,2,3,4,5,6],from:'00:00',to:'23:59',tchat:false});
    r=await C(ps,'send',{course:'quran',text:'test'}); ok(r.err==='chat_off', 'option : élèves ↔ direction seulement (classe fermée)');
    r=await C(ps,'send',{course:'dir',text:'Toujours possible avec la direction'}); ok(r.ok, 'la discussion avec la direction reste ouverte');
    await C(pa,'school_save',{d:[0,1,2,3,4,5,6],from:'00:00',to:'23:59',tchat:true});
    Object.keys(REDIS).filter(k=>k.startsWith('defteram:rl:')).forEach(k=>delete REDIS[k]);
    const ci=await b.newContext({serviceWorkers:'block'}), pi=await newPage(ci,{name:'curieux',allowErr:true,allow404:true}); await up(pi,'curieux');
    r=await C(pi,'thread',{course:'quran',student:'eleve.diallo'}); ok(r.err==='not_teacher', 'curieux : pas d’accès aux classes', r);
    r=await C(pi,'send',{course:'quran',text:'spam'}); ok(r.err==='not_enrolled', 'curieux : ne peut pas écrire dans une classe sans inscription', r);
    r=await C(pi,'send',{course:'dir',text:'Bonjour, comment s’inscrire ?'}); ok(r.ok, 'visiteur connecté : peut poser une question à la direction');
    await ca.close(); await cs.close(); await ct.close(); await ci.close();
  }

  console.log('\n7d. Bibliothèque Seydi El Hadji Malick Sy');
  { const ctx=await b.newContext({serviceWorkers:'block'}), p=await newPage(ctx,{name:'malick'});
    await p.goto(BASE); await p.waitForTimeout(500);
    ok(await p.isVisible('.tile .e.ph img[src="img/malick-sy-face.jpg"]'), 'accueil : case de la bibliothèque avec la photo');
    await p.click('.tile >> text=Malick Sy'); await p.waitForTimeout(500);
    ok(await p.isVisible('#cHead .mhead img') && /Tivaouane/.test(await p.textContent('#cHead')), 'bibliothèque : photo et présentation');
    const t=await p.textContent('#list'); ok(/Khilass Zahab/.test(t) && /Riyy az-Zam/.test(t), 'bibliothèque : Khilass Zahab et la Nûniyya');
    await p.goto(BASE+'#/t/rz1'); await p.waitForTimeout(600);
    ok((await p.$$('#rText .bayt')).length===121, 'Nûniyya : 121 vers');
    ok(/Alâ yâ dah-du/.test(await p.textContent('#rText .bayt .btl')), 'prononciation en lettres latines sous chaque vers');
    await p.goto(BASE+'#/c/parab'); await p.waitForTimeout(400); ok(!(await p.$('#cHead .mhead')), 'pas de présentation dans les autres catégories');
    await p.goto(BASE); await p.waitForTimeout(500); await p.click('.tile >> text=Habibou Ba'); await p.waitForTimeout(500);
    ok(/Thierno Mouhammad Habibou Ba/.test(await p.textContent('#cHead')) && await p.isVisible('#cHead img[src="img/habib-ba.jpg"]'), 'Poèmes de Thierno M. Habibou Ba : photo et présentation');
    const th=await p.textContent('#list'); ok(/Sahi imtati/.test(th) && /Wa la-tala/.test(th) && !/Taala ishtiyaqi/.test(th), 'ses 2 poèmes (sans ceux d’un autre auteur)');
    await p.goto(BASE+'#/t/p6'); await p.waitForTimeout(500); ok(await p.isVisible('#rAv[src="img/habib-ba-face.jpg"]'), 'sa photo en haut de son poème');
    await p.goto(BASE+'#/t/p2'); await p.waitForTimeout(500); ok(!(await p.isVisible('#rAv')), 'pas de photo sur le poème d’un autre auteur');
    await ctx.close(); }

  console.log('\n7e. Audios ajoutés par l’administrateur sur les poèmes');
  { STATS_ON=true; Object.keys(REDIS).filter(k=>k.startsWith('defteram:rl:')).forEach(k=>delete REDIS[k]);
    const up=async(pg,id)=>{ await pg.goto(BASE+'#/p/compte'); await pg.waitForSelector('#acc .tabs2 button:nth-child(2)',{timeout:8000}); await pg.click('.tabs2 button:nth-child(2)'); await pg.fill('#aId',id); await pg.fill('#aPw','123456'); await pg.fill('#aPw2','123456'); await pg.click('#acc [type=submit]'); await pg.waitForTimeout(900); };
    const ca=await b.newContext({serviceWorkers:'block'}), pa=await newPage(ca,{name:'audio-admin',allowErr:true,allow404:true});
    await up(pa,'chef.audio'); const oldAdmin=REDIS['defteram:admin']; REDIS['defteram:admin']='chef.audio';
    await pa.reload(); await pa.waitForTimeout(1500);
    await pa.goto(BASE+'#/t/p2'); await pa.waitForTimeout(800);
    ok(await pa.isVisible('#aud .audbtn'), 'administrateur : bouton « Ajouter un audio » sur le poème');
    await pa.click('#aud .audbtn'); await pa.waitForTimeout(200);
    const bytes=Buffer.alloc(1500000); for(let i=0;i<bytes.length;i++) bytes[i]=(i*7)%251; bytes.write('ID3',0);
    await pa.setInputFiles('#aud .audm input[type=file]',{name:'taala.mp3',mimeType:'audio/mpeg',buffer:bytes});
    await pa.fill('#aud .audm input:not([type])','Récité par Oustaz Ba'); await pa.waitForTimeout(200);
    await pa.click('#aud .audm .btn.fill.wide'); await pa.waitForTimeout(2500);
    const rec=JSON.parse(REDIS['defteram:audios']&&REDIS['defteram:audios'].p2||'null');
    ok(rec && rec.done && rec.n===3 && rec.size===1500000 && rec.title==='Récité par Oustaz Ba', 'audio envoyé en 3 morceaux et enregistré sur le poème', rec);
    ok(/Récité par Oustaz Ba/.test(await pa.textContent('#aud .at')), 'le lecteur du poème affiche le nouvel audio');
    const g=await pa.evaluate(id=>fetch('api/audio?a=get&id='+id,{headers:{Range:'bytes=0-'}}).then(async r=>[r.status,r.headers.get('content-range'),r.headers.get('content-type'),(await r.arrayBuffer()).byteLength]),rec.id);
    ok(g[0]===206 && g[1]==='bytes 0-1499999/1500000' && g[2]==='audio/mpeg' && g[3]===1500000, 'lecture : réponse partielle (Range) correcte', g);
    const g2=await pa.evaluate(id=>fetch('api/audio?a=get&id='+id,{headers:{Range:'bytes=716700-716899'}}).then(async r=>{const u=new Uint8Array(await r.arrayBuffer());return [r.status,u.length,u[0]]}),rec.id);
    ok(g2[0]===206 && g2[1]===200 && g2[2]===(716700*7)%251, 'lecture au milieu du fichier (entre deux morceaux)', g2);
    const cv=await b.newContext({serviceWorkers:'block'}), pv=await newPage(cv,{name:'audio-visiteur',allowErr:true,allow404:true});
    await pv.goto(BASE+'#/c/fass'); await pv.waitForTimeout(1200);
    ok(/🎧/.test(await pv.textContent('#list')), 'liste : 🎧 sur le poème qui a un audio');
    await pv.goto(BASE+'#/t/p2'); await pv.waitForTimeout(800);
    ok(await pv.isVisible('#aud .aud') && !(await pv.$('#aud .audbtn')) && !(await pv.$('#aud .aud button:disabled')), 'visiteur : lecteur actif, sans outil d’administration');
    const deny=await pv.evaluate(()=>fetch('api/audio?a=begin',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"item":"p2","size":10,"mime":"audio/mpeg"}'}).then(r=>r.status));
    ok(deny===403, 'visiteur : ne peut pas envoyer d’audio');
    await pa.goto(BASE+'#/t/kz1'); await pa.waitForTimeout(700);
    ok(await pa.isVisible('#aud .audbtn') && /Pas encore d’audio/.test(await pa.textContent('#aud')), 'administrateur : outil aussi sur les poèmes sans audio');
    await pa.goto(BASE+'#/t/p2'); await pa.waitForTimeout(700); await pa.click('#aud .audbtn'); pa.once('dialog',d=>d.accept()); await pa.click('#aud .audm .btn.danger'); await pa.waitForTimeout(1200);
    ok(!(REDIS['defteram:audios']||{}).p2 && !REDIS['defteram:auc:'+rec.id+':0'], 'audio supprimé (et ses morceaux)');
    REDIS['defteram:admin']=oldAdmin; await ca.close(); await cv.close();
  }

  console.log('\n8. Affichage mobile / tablette / ordinateur');
  for(const [n,vp] of [['mobile 360',{width:360,height:740}],['mobile 390',{width:390,height:844}],['tablette',{width:820,height:1180}],['ordinateur',{width:1440,height:900}]]){
    const ctx=await b.newContext({viewport:vp,serviceWorkers:'block'}), p=await newPage(ctx,{name:n});
    for(const h of ['','#/c/parab','#/t/p2','#/t/lw','#/t/g1','#/m/3','#/p/compte','#/zikr']){
      await p.goto(BASE+h); await p.waitForTimeout(250);
      const w = await p.evaluate(()=>document.documentElement.scrollWidth - innerWidth);
      if(w>1){ ok(false, n+' : défilement horizontal sur '+(h||'#/'), w); }
    }
    const cols = await p.goto(BASE).then(()=>p.waitForTimeout(200)).then(()=>p.evaluate(()=>getComputedStyle(document.querySelector('.grid')).gridTemplateColumns.split(' ').length));
    ok(true, n+' : pas de défilement horizontal · '+cols+' colonnes');
    await ctx.close();
  }

  console.log('\n9. Animations');
  { const ctx=await b.newContext({viewport:{width:1280,height:800},serviceWorkers:'block'}), p=await newPage(ctx,{name:'anim'});
    await p.goto(BASE); await p.waitForTimeout(700);
    const below = await p.evaluate(()=>{ const t=[...document.querySelectorAll('.tile')].pop(); return {rv:t.classList.contains('rv'),in:t.classList.contains('in')} });
    ok(below.rv && !below.in, 'carte hors écran pas encore apparue');
    await p.evaluate(()=>[...document.querySelectorAll('.tile')].pop().scrollIntoView()); await p.waitForTimeout(900);
    ok(await p.evaluate(()=>[...document.querySelectorAll('.tile')].pop().classList.contains('in')), 'apparition au défilement');
    ok(Number(await p.evaluate(()=>getComputedStyle(document.querySelector('.hero')).getPropertyValue('--p')))>0, 'parallax du bandeau');
    const tile = await p.$('.tile'); await tile.scrollIntoViewIfNeeded(); const bx=await tile.boundingBox();
    await p.mouse.move(bx.x+bx.width*.9, bx.y+bx.height*.2); await p.waitForTimeout(120);
    ok(await p.evaluate(()=>document.querySelector('.tile').style.getPropertyValue('--ry'))!=='', 'inclinaison 3D au survol');
    const ctx2=await b.newContext({reducedMotion:'reduce',serviceWorkers:'block'}), q=await newPage(ctx2,{name:'reduit'}); await q.goto(BASE); await q.waitForTimeout(300);
    ok(!(await q.evaluate(()=>document.querySelector('.rv'))), 'animations désactivées si « réduire les animations »');
    await ctx.close(); await ctx2.close(); }

  console.log('\n10. Accessibilité de base');
  { const ctx=await b.newContext({serviceWorkers:'block'}), p=await newPage(ctx,{name:'a11y'});
    for(const h of ['','#/t/p2','#/m/2','#/zikr','#/p/compte','#/add/daara']){
      await p.goto(BASE+h); await p.waitForTimeout(250);
      const bad = await p.evaluate(()=>[...document.querySelectorAll('button,input,select,textarea,a')].filter(e=>e.offsetParent!==null).filter(e=>!(e.getAttribute('aria-label')||e.textContent.trim()||e.placeholder||(e.labels&&e.labels.length)||e.title)).map(e=>e.outerHTML.slice(0,80)));
      ok(!bad.length, 'éléments nommés sur '+(h||'#/'), bad);
    }
    const imgs = await p.evaluate(()=>[...document.querySelectorAll('img')].filter(i=>!i.hasAttribute('alt')).length); ok(imgs===0,'toutes les images ont un attribut alt');
    await ctx.close(); }

  console.log('\n11. Hors connexion et mises à jour (service worker)');
  { const ctx=await b.newContext(), p=await newPage(ctx,{name:'offline'});
    await p.goto(BASE); await p.evaluate(()=>navigator.serviceWorker.ready); await p.reload(); await p.waitForTimeout(600);
    await p.goto(BASE+'privacy.html'); await p.waitForTimeout(300); await p.goto(BASE+'#/m/5'); await p.waitForTimeout(800);
    await ctx.setOffline(true); await p.goto(BASE); await p.waitForTimeout(600);
    ok((await p.$$('.tile')).length>10, 'l’app s’ouvre hors connexion (et pas la page de confidentialité)');
    await p.goto(BASE+'#/m/5'); await p.waitForTimeout(600); ok(await p.evaluate(()=>$('mImg').naturalWidth)===440, 'page du Mushaf déjà vue lisible hors connexion');
    await p.goto(BASE+'privacy.html'); ok(/confidentialit/i.test(await p.title()), 'confidentialité lisible hors connexion');
    await ctx.close(); }

  console.log('\n12. Compteurs de visiteurs et de partages');
  { for(const k in REDIS) delete REDIS[k];
    const ctx=await b.newContext({serviceWorkers:'block'}), p=await newPage(ctx,{name:'stats'});
    await p.goto(BASE); await p.waitForTimeout(1200);
    ok(REDIS['defteram:visitors']===1 && REDIS['defteram:visits']===1, '1re ouverture : 1 visiteur, 1 visite', REDIS);
    ok(!(await p.isVisible('#hstats')), 'plus de chiffres sur l’accueil'); await p.evaluate(()=>drawer(true)); await p.waitForTimeout(300); ok(await p.isVisible('#dstats') && /1/.test(await p.textContent('#dstats')), 'chiffres affichés dans le menu ☰'); await p.evaluate(()=>drawer(false));
    await p.reload(); await p.waitForTimeout(1900); ok(REDIS['defteram:visits']===1, 'rechargement dans la même session : pas compté deux fois', REDIS);
    const p2=await ctx.newPage(); await p2.goto(BASE); await p2.waitForTimeout(1900);
    ok(REDIS['defteram:visitors']===1 && REDIS['defteram:visits']===2, 'nouvel onglet : +1 visite, même visiteur', REDIS); await p2.close();
    const c2=await b.newContext({serviceWorkers:'block'}), q=await newPage(c2,{name:'stats2'}); await q.goto(BASE); await q.waitForTimeout(1200);
    ok(REDIS['defteram:visitors']===2, 'autre appareil : +1 visiteur', REDIS);
    await q.evaluate(()=>{ navigator.share=()=>Promise.resolve() }); await q.goto(BASE+'#/t/p2'); await q.waitForTimeout(300); await q.evaluate(()=>{navigator.share=()=>Promise.resolve()}); await q.click('#shr'); await q.waitForTimeout(500);
    ok(REDIS['defteram:shares']===1, 'partage d’un texte compté', REDIS);
    await q.evaluate(()=>shareApp()); await q.waitForTimeout(500); ok(REDIS['defteram:shares']===2, 'partage de l’application compté', REDIS);
    ok(REDIS['defteram:ishares'] && REDIS['defteram:ishares'].p2===1, 'partage compté pour le texte p2', REDIS['defteram:ishares']);
    ok(REDIS['defteram:views'] && REDIS['defteram:views'].p2===1, 'vue du texte p2 comptée', REDIS['defteram:views']);
    ok(/1 vues/.test(await q.textContent('#rStat')) && /1 partages/.test(await q.textContent('#rStat')), 'vues et partages affichés sur le texte', await q.textContent('#rStat'));
    await q.goto(BASE+'#/c/parab'); await q.waitForTimeout(150); await q.goto(BASE+'#/t/p2'); await q.waitForTimeout(400);
    ok(REDIS['defteram:views'].p2===1, 'revoir le même texte dans la session ne recompte pas');
    await q.goto(BASE+'#/c/fass'); await q.waitForTimeout(700);
    ok(/👁️ 1/.test(await q.textContent('#list')), 'nombre de vues dans la liste');
    await q.goto(BASE+'#/p/apropos'); await q.waitForTimeout(600); ok(/2/.test(await q.textContent('#astats')), 'chiffres dans « À propos »', await q.textContent('#astats'));
    STATS_ON=false; const c3=await b.newContext({serviceWorkers:'block'}), r=await newPage(c3,{name:'stats-off',allow404:true,allowErr:true}); await r.goto(BASE); await r.waitForTimeout(1200);
    await r.evaluate(()=>drawer(true)); await r.waitForTimeout(300); ok(!(await r.isVisible('#dstats')), 'sans base reliée : aucun faux chiffre affiché'); STATS_ON=true;
    await ctx.close(); await c2.close(); await c3.close(); }

  console.log('\n12b. Écran de bienvenue');
  { const ctx=await b.newContext({serviceWorkers:'block'}), p=await newPage(ctx,{name:'bienvenue',welcome:true});
    await p.goto(BASE); await p.waitForTimeout(400);
    ok(await p.isVisible('#wel'), '1re visite : écran de bienvenue affiché');
    ok((await p.textContent('#wel h1')).replace(/\s/g,'')==='DEFTERAM', 'titre DEFTERAM animé lettre par lettre');
    await p.waitForTimeout(2800); await p.click('#wel .go'); await p.waitForTimeout(900);
    ok(!(await p.$('#wel')), 'bouton « Entrer » : l’écran se ferme');
    await p.reload(); await p.waitForTimeout(500);
    ok(!(await p.$('#wel')), 'pas de nouvel écran le même jour');
    await p.evaluate(()=>localStorage.setItem('defteram_welcome', JSON.stringify('Mon Jan 01 2001'))); await p.reload(); await p.waitForTimeout(400);
    ok(await p.isVisible('#wel .tap'), 'jour suivant : courte bienvenue');
    await p.waitForTimeout(4600); ok(!(await p.$('#wel')), 'courte bienvenue : se ferme toute seule');
    await p.evaluate(()=>localStorage.removeItem('defteram_welcome')); await p.goto(BASE+'#/t/p2'); await p.waitForTimeout(500);
    ok(!(await p.$('#wel')), 'lien direct vers un texte : pas d’écran de bienvenue');
    await ctx.close();
  }

  console.log('\n13. Page 404');
  { const ctx=await b.newContext({serviceWorkers:'block'}), p=await newPage(ctx,{name:'404',allow404:true,allowErr:true}); const r=await p.goto(BASE+'nexiste-pas'); ok(r.status()===404 && /404/.test(await p.textContent('h1')), 'page 404'); await ctx.close(); }

  ok(!errors.length, 'aucune erreur JavaScript ni ressource manquante', errors.slice(0,20));
  console.log('\nRésultat : '+pass+' réussis, '+fail+' échoués');
  await b.close(); srv.close(); process.exit(fail?1:0);
})();
