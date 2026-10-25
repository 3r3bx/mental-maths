/* Offline cache. Serves the saved copy instantly, then quietly fetches a
   fresh one in the background, so an update shows up on the next launch. */
const CACHE = 'mental-maths';
const FILES = ['./', './index.html', './manifest.webmanifest', './icon-180.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request, {ignoreSearch: true});
    const net = fetch(e.request)
      .then(r => { if (r.ok) c.put(e.request, r.clone()); return r; })
      .catch(() => hit);
    return hit || net;
  }));
});

/* ---- daily streak reminder ----
   The push carries no data. The message is written here from the copy of
   the streak the app keeps in the 'mm-state' cache. Safari requires every
   push to show a notification, so a finished day gets a "streak safe" one. */
function today(){
  const t = new Date();
  return t.getFullYear() + '-' + String(t.getMonth()+1).padStart(2,'0') + '-' + String(t.getDate()).padStart(2,'0');
}

function dayGap(a, b){
  const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1]-1, pb[2]) - Date.UTC(pa[0], pa[1]-1, pa[2])) / 86400000);
}

function notice(s){
  const you = s.name ? `${s.name}, your` : 'Your';
  if(!s.lastPlayed) return {title: '⚡ Time for maths!', body: 'A 60-second sprint starts your first streak.', due: true};
  const missed = dayGap(s.lastPlayed, today()) - 1;
  if(missed < 0) return {title: '✅ Streak safe!', body: `${you} ${s.streak}-day streak is safe. See you tomorrow!`, due: false};
  if(missed > (s.freezes || 0)) return {title: '⚡ Time for maths!', body: 'A 60-second sprint starts a new streak today.', due: true};
  if(missed === 0 && !s.freezes) return {title: '🔥 Your streak ends tonight!', body: `${you} ${s.streak}-day streak needs one round today. A 60-second sprint saves it.`, due: true};
  return {title: '🔥 Keep your streak going!', body: `${you} ${s.streak}-day streak needs one round today.`, due: true};
}

/* One push a day covers every player on the iPad. Older saves held a
   single player's streak rather than a list. */
function joinNames(xs){
  return xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];
}

function noticeAll(st){
  const kids = Array.isArray(st.kids) ? st.kids : [st];
  if(kids.length === 1) return notice(kids[0]);
  const all = kids.map(k => ({k, n:notice(k)}));
  const waiting = all.filter(x => x.n.due);
  if(!waiting.length) return {title:'✅ Streaks safe!', body:`${joinNames(all.map(x => x.k.name))}: every streak is safe today. See you tomorrow!`, due:false};
  if(waiting.length === 1){
    const {k, n} = waiting[0];
    return {...n, body:n.body.startsWith(k.name) ? n.body : `${k.name}: ${n.body}`};
  }
  return {title:'🔥 Time for maths!', body:`${joinNames(waiting.map(x => x.k.name))} each need one round today to keep their streaks going.`, due:true};
}

self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let s = {};
    try {
      const c = await caches.open('mm-state');
      const r = await c.match(new URL('state.json', self.registration.scope).href);
      if (r) s = await r.json();
    } catch {}
    const n = noticeAll(s);
    if (n.due && self.navigator.setAppBadge) self.navigator.setAppBadge(1).catch(() => {});
    await self.registration.showNotification(n.title, {
      body: n.body, icon: 'icon-180.png', badge: 'icon-180.png', tag: 'streak'
    });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(wins =>
    wins.length ? wins[0].focus() : self.clients.openWindow(self.registration.scope)));
});
