// DEFTERAM service worker
// - Pages : réseau d'abord (avec délai max), donc les nouveautés du site s'affichent dès l'ouverture.
//   Sans connexion, la dernière version enregistrée est affichée.
// - Autres fichiers du site : affichés depuis le cache puis rafraîchis en arrière-plan.
const V='defteram-v14';
const CORE=['./','./index.html','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(CORE.map(u=>new Request(u,{cache:'reload'})))).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
function put(req,res){if(res&&res.ok&&res.status===200&&!res.redirected){const c=res.clone();caches.open(V).then(h=>h.put(req,c))}return res}
self.addEventListener('fetch',e=>{
 const r=e.request; if(r.method!=='GET'||r.headers.has('range'))return;
 const u=new URL(r.url);
 if(r.mode==='navigate'){
  const app=/\/(index\.html)?$/.test(u.pathname),key=app?'./index.html':u.origin+u.pathname;
  const net=fetch(u.origin+u.pathname+u.search,{cache:'no-cache',credentials:'same-origin'}).then(x=>put(key,x));
  e.respondWith(new Promise((ok,no)=>{let done=false;const fin=x=>{if(!done&&x){done=true;ok(x)}};
   const old=()=>caches.match(key).then(m=>m||(app?null:caches.match('./index.html')));
   setTimeout(()=>old().then(fin),6000);
   net.then(fin,()=>old().then(m=>m?fin(m):(done||no(new Error('offline')))));
  }));
  e.waitUntil(net.catch(()=>{}));return}
 if(u.origin===location.origin&&(u.pathname.indexOf('/api/')===0||u.pathname.indexOf('/_vercel/')===0))return;
 const font=/fonts\.(googleapis|gstatic)\.com$/.test(u.hostname);
 if(u.origin!==location.origin&&!font)return;
 e.respondWith(caches.match(r).then(m=>{
  if(m&&font)return m;
  const net=fetch(r).then(x=>put(r,x));
  if(m){e.waitUntil(net.catch(()=>{}));return m}
  return net}));
});
