const V='defteram-v4';
const CORE=['./','./index.html','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
 const r=e.request; if(r.method!=='GET'||r.headers.has('range'))return;
 const u=new URL(r.url);
 if(r.mode==='navigate'){e.respondWith(fetch(r).then(x=>{const c=x.clone();caches.open(V).then(h=>h.put('./index.html',c));return x}).catch(()=>caches.match('./index.html')));return}
 if(u.origin!==location.origin&&!/fonts\.(googleapis|gstatic)\.com$/.test(u.hostname))return;
 e.respondWith(caches.match(r).then(m=>m||fetch(r).then(x=>{if(x.ok&&x.status===200){const c=x.clone();caches.open(V).then(h=>h.put(r,c))}return x})));
});
