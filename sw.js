/* offline cache for 戲劇音樂播放台 — the version comes from the registration URL (sw.js?v=1.2) */
const V = new URL(location.href).searchParams.get('v') || '0';
const CACHE = 'dramaplayer-' + V;
const SHELL = ['./', './index.html', './app.css', './app.js', './jszip.min.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './apple-touch-icon.png',
  './SE/long_clapping.mp3', './SE/Freesound.org-Laugh_13.mp3', './SE/people_people-shout-oo1.mp3', './SE/ta_ge_quiz_poku01.mp3',
  './SE/ta_ge_quiz_yes01.mp3', './SE/incorrect1.mp3', './SE/ta_ta_jikangire01.mp3'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('dramaplayer-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// network first (so updates arrive), cache as fallback when offline
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const range = req.headers.get('range');
  if (range) { e.respondWith(fetch(req).catch(() => rangeFromCache(req, range))); return; }
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok && res.status === 200) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
  );
});

// offline: answer "Range: bytes=a-b" requests for cached audio with a 206 slice
async function rangeFromCache(req, range) {
  const hit = await caches.match(req.url, { ignoreSearch: true });
  if (!hit) return new Response('', { status: 504 });
  const buf = await hit.arrayBuffer();
  const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
  let start = m[1] ? +m[1] : 0, end = m[2] ? +m[2] : buf.byteLength - 1;
  end = Math.min(end, buf.byteLength - 1);
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: { 'Content-Type': hit.headers.get('Content-Type') || 'audio/mpeg', 'Content-Range': `bytes ${start}-${end}/${buf.byteLength}`,
      'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' }
  });
}
