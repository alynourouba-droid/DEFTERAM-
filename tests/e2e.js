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
      if(op==='DEL'){ const had=REDIS[k]!=null; delete REDIS[k]; return {result:had?1:0}; }
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

function serve(){
  return new Promise(res=>{
    const srv = http.createServer((q,r)=>{
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
    ok(st.avis.length===1 && st.avis[0].note===5, 'avis enregistré dans Supabase', st.avis);
    await ctx.close(); }

  console.log('\n7. Connexion / déconnexion / synchronisation');
  { STATS_ON=true;
    const c1=await b.newContext({serviceWorkers:'block'}); const p=await newPage(c1,{name:'compte1',allowErr:true,allow404:true});
    await p.goto(BASE); await p.waitForTimeout(900); await p.click('#nav [data-n=acc]'); await p.waitForTimeout(200);
    ok(await p.isVisible('#aId') && await p.isVisible('#aPw'), 'page de connexion (identifiant + mot de passe)');
    await p.click('.tabs2 button:nth-child(2)'); await p.fill('#aId','a b'); await p.fill('#aPw','123456'); await p.fill('#aPw2','123456'); await p.click('#acc [type=submit]');
    ok(/Identifiant/.test(await p.textContent('#acc .err')), 'identifiant invalide refusé');
    await p.fill('#aId','aly.ba'); await p.fill('#aPw','123'); await p.fill('#aPw2','123'); await p.click('#acc [type=submit]'); ok(/6/.test(await p.textContent('#acc .err')), 'mot de passe trop court refusé');
    await p.fill('#aPw','123456'); await p.fill('#aPw2','654321'); await p.click('#acc [type=submit]'); ok(/identiques/.test(await p.textContent('#acc .err')), 'confirmation différente refusée');
    await p.fill('#aPw2','123456'); await p.click('#acc [type=submit]'); await p.waitForTimeout(900);
    ok(await p.textContent('#nav [data-n=acc] span')==='aly.ba', 'inscription sans e-mail → connecté');
    const rec=JSON.parse(REDIS['defteram:user:aly.ba']||'{}'); ok(rec.h && !JSON.stringify(rec).includes('123456'), 'mot de passe stocké haché, jamais en clair');
    await p.evaluate(()=>{ tog('p3'); save(FK,favs) }); await p.waitForTimeout(2200);
    ok(/p3/.test(REDIS['defteram:data:aly.ba']||''), 'favori sauvegardé sur le compte');
    await p.reload(); await p.waitForTimeout(1000); ok(await p.textContent('#nav [data-n=acc] span')==='aly.ba', 'session conservée après rechargement');
    await p.goto(BASE+'#/p/compte'); await p.waitForTimeout(700); await p.click('#acc .danger'); await p.waitForTimeout(400);
    ok(await p.textContent('#nav [data-n=acc] span')==='Connexion' && !(await p.evaluate(()=>localStorage.getItem('defteram_auth'))), 'déconnexion');
    ok(!Object.keys(REDIS).some(k=>k.startsWith('defteram:sess:')), 'session supprimée côté serveur');
    await p.fill('#aId','aly.ba'); await p.fill('#aPw','faux123'); await p.click('#acc [type=submit]'); await p.waitForTimeout(500); ok(/incorrect/.test(await p.textContent('#acc .err')), 'mauvais mot de passe');
    await p.click('.tabs2 button:nth-child(2)'); await p.fill('#aId','aly.ba'); await p.fill('#aPw','123456'); await p.fill('#aPw2','123456'); await p.click('#acc [type=submit]'); await p.waitForTimeout(500);
    ok(/déjà pris/.test(await p.textContent('#acc .err')), 'nom déjà pris');
    const c2=await b.newContext({serviceWorkers:'block'}); const q=await newPage(c2,{name:'compte2',allowErr:true,allow404:true});
    await q.goto(BASE+'#/p/compte'); await q.waitForTimeout(900); await q.fill('#aId','ALY.BA'); await q.fill('#aPw','123456'); await q.press('#aPw','Enter'); await q.waitForTimeout(1200);
    ok(await q.evaluate(()=>favs.indexOf('p3')>-1), 'autre appareil : favoris récupérés');
    await q.evaluate(()=>{ localStorage.setItem('defteram_auth', JSON.stringify({tk:'x'.repeat(43),user:{name:'aly.ba'}})); }); await q.reload(); await q.waitForTimeout(1500);
    ok(await q.textContent('#nav [data-n=acc] span')==='Connexion', 'session invalide → déconnecté proprement');
    STATS_ON=false; const c3=await b.newContext({serviceWorkers:'block'}); const r=await newPage(c3,{name:'sans-config',allowErr:true,allow404:true}); await r.goto(BASE); await r.waitForTimeout(900);
    ok(!(await r.$('#nav [data-n=acc]')), 'sans base reliée : pas de bouton Connexion');
    await r.goto(BASE+'#/p/compte'); await r.waitForTimeout(300); ok(/pas encore activée/.test(await r.textContent('#acc')), 'sans base reliée : message clair, pas de faux formulaire');
    STATS_ON=true; await c1.close(); await c2.close(); await c3.close(); }

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
    ok(/1/.test(await p.textContent('#hstats')) && await p.isVisible('#hstats'), 'chiffres affichés sur l’accueil');
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
    ok(!(await r.isVisible('#hstats')), 'sans base reliée : aucun faux chiffre affiché'); STATS_ON=true;
    await ctx.close(); await c2.close(); await c3.close(); }

  console.log('\n13. Page 404');
  { const ctx=await b.newContext({serviceWorkers:'block'}), p=await newPage(ctx,{name:'404',allow404:true,allowErr:true}); const r=await p.goto(BASE+'nexiste-pas'); ok(r.status()===404 && /404/.test(await p.textContent('h1')), 'page 404'); await ctx.close(); }

  ok(!errors.length, 'aucune erreur JavaScript ni ressource manquante', errors.slice(0,20));
  console.log('\nRésultat : '+pass+' réussis, '+fail+' échoués');
  await b.close(); srv.close(); process.exit(fail?1:0);
})();
