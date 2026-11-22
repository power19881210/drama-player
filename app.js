/* 戲劇音樂播放台 — Android / 網頁版 */
'use strict';
const VERSION = '1.2';
const TRACKS = 20, SES = 10;
const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm', '3gp', 'mkv'];
const BUILTIN_SE = [
  ['鼓掌', 'long_clapping.mp3'], ['群笑', 'Freesound.org-Laugh_13.mp3'], ['喔！', 'people_people-shout-oo1.mp3'],
  ['滴答', 'ta_ge_quiz_poku01.mp3'], ['答對', 'ta_ge_quiz_yes01.mp3'], ['答錯', 'incorrect1.mp3'], ['時間到', 'ta_ta_jikangire01.mp3'],
];
const BUILTIN_NAMES = BUILTIN_SE.map(x => x[1].toLowerCase());
const ZOOMS = [[16, '標準'], [18.5, '大'], [21, '特大']];

const $ = s => document.querySelector(s);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function mmss(s) { if (!isFinite(s) || s < 0) s = 0; s = Math.floor(s); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }
function mmssF(s) {
  if (!s || s <= 0) return '';
  let t = Math.floor(s), d = Math.round((s - t) * 10); if (d === 10) { t++; d = 0; }
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0') + (d ? '.' + d : '');
}
function parseTime(txt) {
  txt = (txt || '').trim().replace(/：/g, ':').replace(/．/g, '.');
  if (!txt) return 0;
  const p = txt.split(':');
  if (p.length > 3 || p.some(x => x === '' || isNaN(Number(x)))) return null;
  let s = 0; for (const x of p) s = s * 60 + Number(x);
  return s >= 0 ? s : null;
}
function isVideoName(n) { const e = (n || '').split('.').pop().toLowerCase(); return VIDEO_EXT.includes(e); }
function baseName(p) { return (p || '').replace(/\\/g, '/').split('/').pop(); }
function stem(n) { const b = baseName(n); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(0, i) : b; }

/* ------------------------------------------------------------------ storage */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('dramaplayer', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files', { keyPath: 'id' });
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(mode) { return this.db.transaction('files', mode).objectStore('files'); },
  put(rec) { return new Promise((res, rej) => { const r = this.tx('readwrite').put(rec); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); },
  get(id) { return new Promise((res, rej) => { const r = this.tx('readonly').get(id); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  del(id) { return new Promise(res => { const r = this.tx('readwrite').delete(id); r.onsuccess = r.onerror = () => res(); }); },
  keys() { return new Promise((res, rej) => { const r = this.tx('readonly').getAllKeys(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
};
let idSeq = Date.now();
async function storeFile(blob, name) {
  const id = 'f' + (idSeq++).toString(36);
  await DB.put({ id, name, type: blob.type || '', blob });
  return id;
}

const urlCache = new Map();
async function mediaUrl(fileId) {
  if (!fileId) return null;
  if (fileId.startsWith('builtin:')) return 'SE/' + fileId.slice(8);
  if (urlCache.has(fileId)) return urlCache.get(fileId);
  const rec = await DB.get(fileId);
  if (!rec) return null;
  const u = URL.createObjectURL(rec.blob);
  urlCache.set(fileId, u);
  return u;
}

/* ------------------------------------------------------------------ volume (iOS needs Web Audio) */
// iOS Safari ignores media.volume, so volume and fade-outs go through a Web Audio GainNode there.
const NEED_GAIN = (() => {
  try { if (localStorage.getItem('dp_forceGain') === '1') return true; const a = new Audio(); a.volume = 0.5; return Math.abs(a.volume - 0.5) > 0.01; }
  catch (e) { return false; }
})();
let actx = null;
function audioCtx() {
  if (!actx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    actx = new C();
  }
  return actx;
}
function resumeAudio() {
  // play through the ring/silent switch on iOS 17+
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { }
  const c = actx; if (c && c.state !== 'running') return c.resume().catch(() => { });
  return Promise.resolve();
}
function attachGain(m) {
  if (!NEED_GAIN || m._gain) return;
  const c = audioCtx(); if (!c) return;
  try {
    const src = c.createMediaElementSource(m), g = c.createGain();
    src.connect(g); g.connect(c.destination); m._gain = g;
  } catch (e) { }
}
function setVol(m, v) { v = clamp(v, 0, 1); if (m._gain) m._gain.gain.value = v; else m.volume = v; }
function getVol(m) { return m._gain ? m._gain.gain.value : m.volume; }
document.addEventListener('pointerdown', () => { if (NEED_GAIN) { audioCtx(); resumeAudio(); } }, true);

function newTrack() { return { fileId: '', fileName: '', title: '', start: 0, end: 0, volume: 80, repeat: false }; }
function newSe() { return { name: '', fileId: '', fileName: '' }; }
function newScene(name) {
  return { name, tracks: Array.from({ length: TRACKS }, newTrack), se: Array.from({ length: SES }, newSe) };
}
function defaultSe(sc) { BUILTIN_SE.forEach((x, i) => { sc.se[i] = { name: x[0], fileId: 'builtin:' + x[1], fileName: x[1] }; }); }
function cloneScene(s, name) { const c = JSON.parse(JSON.stringify(s)); c.name = name; return c; }

let cfg;
function loadCfg() {
  try { cfg = JSON.parse(localStorage.getItem('dp_config') || 'null'); } catch (e) { cfg = null; }
  if (!cfg || !Array.isArray(cfg.scenes) || !cfg.scenes.length) {
    const s = newScene('預設場次'); defaultSe(s);
    cfg = { scenes: [s], current: 0, seVolume: 90, fadeSeconds: 3, textSize: 0, layout: 'auto' };
  }
  for (const s of cfg.scenes) {
    while (s.tracks.length < TRACKS) s.tracks.push(newTrack());
    while (s.se.length < SES) s.se.push(newSe());
  }
  cfg.current = clamp(cfg.current | 0, 0, cfg.scenes.length - 1);
  if (!cfg.layout) cfg.layout = 'auto';
}
let saveTimer = 0;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }
function saveNow() { clearTimeout(saveTimer); try { localStorage.setItem('dp_config', JSON.stringify(cfg)); } catch (e) { toast('設定儲存失敗：' + e.message); } gcSoon(); }
const scene = () => cfg.scenes[cfg.current];

/* remove stored files no scene refers to any more */
let gcTimer = 0;
function gcSoon() { clearTimeout(gcTimer); gcTimer = setTimeout(gc, 3000); }
async function gc() {
  const used = new Set();
  for (const s of cfg.scenes) { s.tracks.forEach(t => t.fileId && used.add(t.fileId)); s.se.forEach(e => e.fileId && used.add(e.fileId)); }
  for (const id of pendingIds) used.add(id);
  const keys = await DB.keys();
  for (const k of keys) if (!used.has(k)) { await DB.del(k); if (urlCache.has(k)) { URL.revokeObjectURL(urlCache.get(k)); urlCache.delete(k); } }
}
const pendingIds = new Set();   // files picked in an open dialog, not yet saved

/* ------------------------------------------------------------------ tracks */
class Track {
  constructor(i) {
    this.i = i; this.media = null; this.state = 'idle'; this.pos = 0; this.dur = 0; this.cue = -1;
    this.fading = false; this.fadeStart = 0; this.fadeFrom = 1; this.error = ''; this.loadedId = '';
    this.build();
  }
  get c() { return scene().tracks[this.i]; }
  get active() { return this.state === 'playing' || this.state === 'paused'; }

  build() {
    const card = this.card = el('div', 'card');
    this.numEl = el('div', 'num', String(this.i + 1));
    this.titleEl = el('div', 'title');
    this.timeEl = el('div', 'time');
    const ctl = el('div', 'ctl');
    this.bPlay = el('button', 'b play', '▶');
    this.bStop = el('button', 'b', '■');
    this.bLoop = el('button', 'b', '⟲');
    this.bFade = el('button', 'b fade', '淡出');
    this.bSet = el('button', 'b', '⚙');
    const vol = el('div', 'vol');
    this.volIn = el('input'); this.volIn.type = 'range'; this.volIn.min = 0; this.volIn.max = 100;
    this.volLbl = el('span');
    vol.append(this.volIn, this.volLbl);
    ctl.append(this.bPlay, this.bStop, this.bLoop, this.bFade, this.bSet, vol);
    const seek = this.seekEl = el('div', 'seek');
    this.segEl = el('div', 'seg'); this.fillEl = el('div', 'fill'); this.mkS = el('div', 'mk'); this.mkE = el('div', 'mk'); this.knob = el('div', 'knob');
    seek.append(el('div', 'tr'), this.segEl, this.fillEl, this.mkS, this.mkE, this.knob);
    card.append(this.numEl, this.titleEl, this.timeEl, ctl, seek);

    // compact tile for the fit-all layout
    const tile = this.tile = el('div', 'tile');
    const th = el('div', 'th');
    this.tNum = el('span', 'tn', String(this.i + 1)); this.tLoop = el('span', 'tl', '⟲'); this.tMark = el('span', 'tm');
    th.append(this.tNum, this.tLoop, el('span', 'tsp'), this.tMark);
    this.tTitle = el('div', 'tt'); this.tTime = el('div', 'tti');
    const tb = el('div', 'tbtns');
    const tStop = el('button', null, '■'), tFade = el('button', null, '淡出'), tMore = el('button', null, '⋯');
    tb.append(tStop, tFade, tMore);
    this.tBar = el('i'); const bar = el('div', 'tbar'); bar.append(this.tBar);
    tile.append(th, this.tTitle, this.tTime, tb, bar);
    tStop.onclick = e => { e.stopPropagation(); this.stop(); };
    tFade.onclick = e => { e.stopPropagation(); this.fadeOut(); };
    tMore.onclick = e => { e.stopPropagation(); trackActions(this); };
    let lp = 0, longed = false;
    tile.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      longed = false; lp = setTimeout(() => { longed = true; if (navigator.vibrate) navigator.vibrate(25); trackActions(this); }, 550);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => tile.addEventListener(ev, () => clearTimeout(lp)));
    tile.addEventListener('contextmenu', e => e.preventDefault());
    tile.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      if (longed) { longed = false; return; }
      this.toggle();
    });

    this.bPlay.onclick = () => this.toggle();
    this.bStop.onclick = () => this.stop();
    this.bLoop.onclick = () => { this.c.repeat = !this.c.repeat; saveSoon(); this.render(); };
    this.bFade.onclick = () => this.fadeOut();
    this.bSet.onclick = () => trackDialog(this);
    this.titleEl.onclick = () => { if (!this.c.fileId) trackDialog(this); };
    this.volIn.oninput = () => {
      this.c.volume = +this.volIn.value; this.volLbl.textContent = this.c.volume + '%';
      if (this.media && !this.fading) setVol(this.media, this.c.volume / 100);
      saveSoon();
    };
    let drag = false;
    const at = e => { const r = seek.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); };
    seek.addEventListener('pointerdown', e => { if (!this.c.fileId || !this.dur) return; drag = true; seek.setPointerCapture(e.pointerId); this.dragV = at(e); this.renderSeek(); });
    seek.addEventListener('pointermove', e => { if (drag) { this.dragV = at(e); this.renderSeek(); } });
    const end = e => {
      if (!drag) return; drag = false; const v = this.dragV; this.dragV = null;
      if (this.active && this.media) { this.media.currentTime = v * this.dur; this.pos = v * this.dur; }
      else { this.cue = v * this.dur; this.pos = this.cue; }
      this.render();
    };
    seek.addEventListener('pointerup', end); seek.addEventListener('pointercancel', end);
  }

  async ensureLoaded() {
    const c = this.c;
    if (this.media && this.loadedId === c.fileId) return true;
    this.release();
    this.error = '';
    const url = await mediaUrl(c.fileId);
    if (!url) { this.error = '找不到檔案'; this.render(); return false; }
    const m = document.createElement(isVideoName(c.fileName) ? 'video' : 'audio');
    m.preload = 'auto';
    m.setAttribute('playsinline', '');
    m.src = url;
    attachGain(m);
    setVol(m, c.volume / 100);
    m.addEventListener('loadedmetadata', () => { this.dur = m.duration || 0; this.render(); });
    m.addEventListener('ended', () => this.onEnded());
    m.addEventListener('error', () => { this.error = '無法播放此格式'; this.state = 'idle'; this.render(); updateHeader(); });
    this.media = m; this.loadedId = c.fileId;
    return true;
  }

  release() {
    if (this.media) {
      try { this.media.pause(); } catch (e) { }
      if (this.media.parentNode) this.media.parentNode.removeChild(this.media);
      this.media.removeAttribute('src'); try { this.media.load(); } catch (e) { }
      this.media = null;
    }
    if (videoOwner === this) hideVideo();
    this.loadedId = ''; this.state = 'idle'; this.fading = false;
  }

  async toggle() {
    const c = this.c;
    if (!c.fileId) { trackDialog(this); return; }
    if (this.state === 'playing') { this.media.pause(); this.state = 'paused'; this.render(); updateHeader(); return; }
    if (this.state === 'paused') { await this.safePlay(); return; }
    if (!(await this.ensureLoaded())) return;
    this.fading = false;
    setVol(this.media, c.volume / 100);
    const startAt = this.cue >= 0 ? this.cue : c.start;
    this.cue = -1;
    try { this.media.currentTime = startAt || 0; } catch (e) { }
    if (this.media.tagName === 'VIDEO') showVideo(this);
    await this.safePlay();
  }

  async safePlay() {
    await resumeAudio();
    try { await this.media.play(); this.state = 'playing'; }
    catch (e) { this.error = '無法播放：' + (e.message || e.name); this.state = 'idle'; }
    this.render(); updateHeader();
  }

  stop() {
    this.fading = false; this.cue = -1; this.pos = 0;
    if (this.media) {
      this.media.pause();
      setVol(this.media, this.c.volume / 100);
      try { this.media.currentTime = this.c.start || 0; } catch (e) { }
    }
    if (videoOwner === this) hideVideo();
    this.state = 'idle';
    this.render(); updateHeader();
  }

  fadeOut() {
    if (this.state !== 'playing' || this.fading) return;
    this.fading = true; this.fadeStart = performance.now(); this.fadeFrom = getVol(this.media);
    this.render();
  }

  onEnded() {
    if (this.state !== 'playing') return;
    if (this.c.repeat && !this.fading) { this.media.currentTime = this.c.start || 0; this.media.play().catch(() => { }); }
    else this.stop();
  }

  tick(now) {
    if (this.state !== 'playing' || !this.media) return;
    const c = this.c, m = this.media;
    this.pos = m.currentTime;
    if (m.duration && Math.abs(m.duration - this.dur) > .01) this.dur = m.duration;
    const end = c.end > 0 && (!this.dur || c.end < this.dur) ? c.end : 0;
    if (end && this.pos >= end) {
      if (c.repeat && !this.fading) { m.currentTime = c.start || 0; }
      else { this.stop(); return; }
    }
    if (this.fading) {
      const t = (now - this.fadeStart) / 1000 / Math.max(1, cfg.fadeSeconds);
      if (t >= 1) { this.stop(); return; }
      setVol(m, this.fadeFrom * (1 - t));
    }
    this.renderTime(); this.renderSeek();
  }

  /** preload metadata so the length shows before playing */
  async preload() {
    if (!this.c.fileId || this.media) return;
    if (isVideoName(this.c.fileName)) return;
    await this.ensureLoaded();
  }

  rebind() { this.release(); this.dur = 0; this.pos = 0; this.cue = -1; this.error = ''; this.render(); }

  render() {
    const c = this.c, has = !!c.fileId;
    this.card.className = 'card' + (this.active ? ' active ' + (this.fading ? 'fading' : this.state) : '');
    if (has) {
      const t = c.title || stem(c.fileName);
      this.titleEl.textContent = (isVideoName(c.fileName) ? '[影片] ' : '') + t;
      this.titleEl.className = 'title';
    } else {
      this.titleEl.textContent = '（空白）按 ⚙ 選擇音樂或影片';
      this.titleEl.className = 'title empty';
    }
    this.bPlay.textContent = this.state === 'playing' ? '❚❚' : '▶';
    [this.bPlay, this.bStop, this.bFade].forEach(b => b.disabled = !has);
    this.bLoop.classList.toggle('on', !!c.repeat);
    this.bFade.classList.toggle('on', this.fading);
    this.volIn.value = c.volume; this.volLbl.textContent = c.volume + '%';
    // tile
    this.tile.className = 'tile' + (has ? '' : ' empty') + (this.active ? ' ' + (this.fading ? 'fading' : this.state) : '');
    this.tTitle.textContent = has ? ((isVideoName(c.fileName) ? '[影片] ' : '') + (c.title || stem(c.fileName))) : '（空白）長按設定';
    this.tLoop.style.display = c.repeat ? '' : 'none';
    this.tMark.textContent = this.state === 'playing' ? '▶' : this.state === 'paused' ? '❚❚' : '';
    this.renderTime(); this.renderSeek();
  }

  renderTime() {
    const c = this.c;
    let t = '', err = false;
    if (!c.fileId) t = '';
    else if (this.error && !this.active) { t = '⚠ ' + this.error; err = true; }
    else {
      const end = c.end > 0 ? c.end : this.dur;
      t = mmss(this.pos) + ' / ' + (this.dur ? mmss(this.dur) : '--:--');
      if (this.active && end) t = '剩 ' + mmss(Math.max(0, end - this.pos)) + '  ' + t;
    }
    this.timeEl.textContent = t;
    this.timeEl.className = 'time' + (err ? ' err' : '');
    // tile: remaining time while active, otherwise total length
    let tt = '';
    if (c.fileId) {
      if (err) tt = '⚠ ' + this.error;
      else if (this.active) { const end = c.end > 0 ? c.end : this.dur; tt = '剩 ' + mmss(Math.max(0, (end || 0) - this.pos)); }
      else tt = this.dur ? mmss((c.end > 0 ? c.end : this.dur) - (c.start || 0)) : '--:--';
    }
    this.tTime.textContent = tt;
    this.tTime.className = 'tti' + (err ? ' err' : '');
  }

  renderSeek() {
    const c = this.c, d = this.dur;
    let v = 0;
    if (this.dragV != null) v = this.dragV;
    else if (d) v = this.active ? this.pos / d : (this.cue >= 0 ? this.cue / d : (c.start || 0) / d);
    v = clamp(v, 0, 1);
    this.fillEl.style.width = (v * 100) + '%';
    this.tBar.style.width = (this.active ? v * 100 : 0) + '%';
    this.knob.style.left = (v * 100) + '%';
    this.knob.style.display = c.fileId && d ? '' : 'none';
    const s = d && c.start > 0 ? clamp(c.start / d, 0, 1) : -1, e = d && c.end > 0 ? clamp(c.end / d, 0, 1) : -1;
    this.mkS.style.display = s > 0 ? '' : 'none'; if (s > 0) this.mkS.style.left = (s * 100) + '%';
    this.mkE.style.display = e > 0 && e < 1 ? '' : 'none'; if (e > 0) this.mkE.style.left = (e * 100) + '%';
    if (s > 0 || (e > 0 && e < 1)) {
      const a = s > 0 ? s : 0, b = e > 0 ? e : 1;
      this.segEl.style.display = ''; this.segEl.style.left = (a * 100) + '%'; this.segEl.style.width = ((b - a) * 100) + '%';
    } else this.segEl.style.display = 'none';
  }
}

/* ------------------------------------------------------------------ video layer */
let videoOwner = null;
function showVideo(t) {
  videoOwner = t;
  const box = $('#videoBox'); box.innerHTML = '';
  box.appendChild(t.media);
  $('#videoLayer').hidden = false;
}
function hideVideo() {
  const t = videoOwner; videoOwner = null;
  $('#videoLayer').hidden = true;
  if (t && t.media && t.media.parentNode) t.media.parentNode.removeChild(t.media);
}
$('#videoClose').onclick = () => { if (videoOwner) videoOwner.stop(); else hideVideo(); };

/* ------------------------------------------------------------------ sound effects */
const se = [];
function buildSe() {
  const grid = $('#segrid'); grid.innerHTML = '';
  for (let i = 0; i < SES; i++) {
    const b = el('button', 'se');
    const k = el('span', 'k', String(i + 1)), lab = el('span', 'l'), p = el('span', 'p');
    b.append(k, lab, p);
    const s = { i, btn: b, lab, bar: p, audio: null, loadedId: '', state: 'idle' };
    se.push(s);
    let timer = 0, longPressed = false;
    b.addEventListener('pointerdown', () => { longPressed = false; timer = setTimeout(() => { longPressed = true; stopSe(s); if (navigator.vibrate) navigator.vibrate(30); }, 600); });
    const cancel = () => clearTimeout(timer);
    b.addEventListener('pointerup', cancel); b.addEventListener('pointerleave', cancel); b.addEventListener('pointercancel', cancel);
    b.addEventListener('contextmenu', e => e.preventDefault());
    b.addEventListener('click', () => { if (longPressed) { longPressed = false; return; } clickSe(s); });
    grid.appendChild(b);
  }
}
function renderSe() {
  for (const s of se) {
    const c = scene().se[s.i];
    const has = !!c.fileId;
    s.lab.textContent = has ? (c.name || stem(c.fileName)) : '（未設定）';
    s.btn.className = 'se' + (has ? '' : ' none') + (s.state === 'playing' ? ' playing' : s.state === 'paused' ? ' paused' : '');
    if (s.state === 'idle') s.bar.style.width = '0';
  }
  $('#sevol').value = cfg.seVolume; $('#sevolLbl').textContent = '音量 ' + cfg.seVolume + '%';
}
async function clickSe(s) {
  const c = scene().se[s.i];
  if (!c.fileId) { seDialog(); return; }
  if (s.audio && s.state === 'playing') { s.audio.pause(); s.state = 'paused'; renderSe(); return; }
  if (s.audio && s.state === 'paused') { s.audio.play().catch(() => { }); s.state = 'playing'; renderSe(); return; }
  if (!s.audio || s.loadedId !== c.fileId) {
    releaseSe(s);
    const url = await mediaUrl(c.fileId);
    if (!url) { toast('找不到音效檔：' + (c.fileName || '')); return; }
    const a = new Audio(); a.preload = 'auto'; a.src = url; attachGain(a);
    a.addEventListener('ended', () => { s.state = 'idle'; renderSe(); });
    s.audio = a; s.loadedId = c.fileId;
  }
  setVol(s.audio, cfg.seVolume / 100);
  await resumeAudio();
  try { s.audio.currentTime = 0; } catch (e) { }
  try { await s.audio.play(); s.state = 'playing'; } catch (e) { toast('音效無法播放：' + (e.message || e.name)); s.state = 'idle'; }
  renderSe();
}
function stopSe(s) {
  if (s.audio) { s.audio.pause(); try { s.audio.currentTime = 0; } catch (e) { } }
  s.state = 'idle'; renderSe();
}
function releaseSe(s) {
  if (s.audio) { s.audio.pause(); s.audio.removeAttribute('src'); try { s.audio.load(); } catch (e) { } }
  s.audio = null; s.loadedId = ''; s.state = 'idle';
}
$('#sevol').oninput = e => {
  cfg.seVolume = +e.target.value; $('#sevolLbl').textContent = '音量 ' + cfg.seVolume + '%';
  for (const s of se) if (s.audio) setVol(s.audio, cfg.seVolume / 100);
  saveSoon();
};
$('#seStop').onclick = () => se.forEach(stopSe);
$('#seSet').onclick = () => seDialog();

/* ------------------------------------------------------------------ main */
const tracks = [];
function buildTracks() {
  const box = $('#tracks'); box.innerHTML = '';
  for (let i = 0; i < TRACKS; i++) { const t = new Track(i); tracks.push(t); box.appendChild(t.card); }
  for (const t of tracks) box.appendChild(t.tile);
}

/* ------------------------------------------------------------------ layouts */
function isFit() {
  if (cfg.layout === 'fit') return true;
  if (cfg.layout === 'list') return false;
  return Math.min(innerWidth, innerHeight) >= 560;      // auto: tablets get the fit-all grid
}
function applyLayout() {
  const fit = isFit();
  document.body.classList.toggle('fit', fit);
  $('#layoutBtn').textContent = fit ? '☰' : '⊞';
  $('#layoutBtn').title = fit ? '切換成清單' : '切換成一頁全覽';
  if (fit) requestAnimationFrame(fitGrid);
}
/** choose columns × rows so all 20 tiles fill the space as large as possible */
function fitGrid() {
  if (!document.body.classList.contains('fit')) return;
  const box = $('#tracks');
  const fs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fs')) || 16;
  const gap = Math.round(fs * .4);
  const W = box.clientWidth - gap * 2, H = box.clientHeight - gap * 2;
  let best = null;
  for (let cols = 2; cols <= 7; cols++) {
    const rows = Math.ceil(TRACKS / cols);
    const w = (W - gap * (cols - 1)) / cols, h = (H - gap * (rows - 1)) / rows;
    if (w <= 0 || h <= 0) continue;
    // ideal tile is about 1.5× wider than tall; penalise very flat or very tall tiles
    const ratio = w / h, shape = ratio > 1.5 ? 1.5 / ratio : ratio / 1.5;
    const score = Math.min(w / 1.5, h) * (0.6 + 0.4 * shape) * (1 - 0.06 * (rows * cols - TRACKS));
    if (!best || score > best.score) best = { cols, rows, w, h, score };
  }
  if (!best) return;
  const tf = clamp(Math.min(best.h / 5.2, best.w / 7.5), 10, fs * 1.25);
  const root = document.body.style;
  root.setProperty('--cols', best.cols); root.setProperty('--rows', best.rows);
  root.setProperty('--gap', gap + 'px'); root.setProperty('--tf', tf.toFixed(1) + 'px');
  const lineH = tf * 1.25;
  const roomy = best.h >= tf * 8.2;
  document.body.classList.toggle('roomy', roomy);
  const free = best.h - tf * (roomy ? 6.3 : 3.9);
  root.setProperty('--lines', clamp(Math.floor(free / lineH), 1, 3));
}
window.addEventListener('resize', () => { applyLayout(); });
$('#layoutBtn').onclick = () => { cfg.layout = isFit() ? 'list' : 'fit'; applyLayout(); saveSoon(); };

/** action sheet for one track (used by the fit-all tiles) */
function trackActions(t) {
  const c = t.c;
  if (!c.fileId) { trackDialog(t); return; }
  let timer = 0;
  openSheet(sh => {
    sh.classList.add('act');
    const h = el('h2', null, `${t.i + 1}. ` + (c.title || stem(c.fileName)));
    const time = el('div', 'lbl2');
    const ta = el('span'), tb = el('span'); time.append(ta, tb);
    const seek = el('input'); seek.type = 'range'; seek.min = 0; seek.max = 1000; seek.step = 1;
    let dragging = false;
    seek.addEventListener('pointerdown', () => dragging = true);
    seek.addEventListener('change', async () => {
      dragging = false;
      if (!t.dur) return;
      const v = seek.value / 1000 * t.dur;
      if (t.active && t.media) { t.media.currentTime = v; t.pos = v; } else { t.cue = v; t.pos = v; }
      t.render(); upd();
    });
    const b1 = el('div', 'big2'), b2 = el('div', 'big2');
    const play = btn('', 'green', async () => { await t.toggle(); upd(); });
    const stop = btn('■ 停止', '', () => { t.stop(); upd(); });
    const fade = btn('淡出', 'purple', () => { t.fadeOut(); upd(); });
    const loop = btn('⟲ 循環', '', () => { c.repeat = !c.repeat; saveSoon(); t.render(); upd(); });
    const set = btn('⚙ 設定', '', () => { closeSheet(); trackDialog(t); });
    b1.append(play, stop, fade); b2.append(loop, set);
    const vl = el('div', 'lbl2'); const vt = el('span'); vl.append(el('span', null, '音量'), vt);
    const vol = el('input'); vol.type = 'range'; vol.min = 0; vol.max = 100; vol.value = c.volume;
    vol.oninput = () => { c.volume = +vol.value; if (t.media && !t.fading) setVol(t.media, c.volume / 100); vt.textContent = c.volume + '%'; t.render(); saveSoon(); };
    const close = el('div', 'btns'); close.append(btn('關閉', '', () => closeSheet()));
    sh.append(h, time, seek, b1, b2, vl, vol, close);
    function upd() {
      play.textContent = t.state === 'playing' ? '❚❚ 暫停' : '▶ 播放';
      play.className = 'b ' + (t.state === 'playing' ? '' : 'green');
      loop.className = 'b ' + (c.repeat ? 'blue' : '');
      const end = c.end > 0 ? c.end : t.dur;
      ta.textContent = mmss(t.pos) + ' / ' + (t.dur ? mmss(t.dur) : '--:--');
      tb.textContent = t.active && end ? '剩 ' + mmss(Math.max(0, end - t.pos)) : '';
      if (!dragging && t.dur) seek.value = Math.round((t.active ? t.pos : (t.cue >= 0 ? t.cue : c.start || 0)) / t.dur * 1000);
      vt.textContent = c.volume + '%';
    }
    upd(); timer = setInterval(upd, 250);
  }, () => clearInterval(timer));
}
function updateHeader() {
  const n = cfg.scenes.length;
  $('#sceneBtn').textContent = '場次：' + scene().name + (n > 1 ? `（${cfg.current + 1}/${n}）` : '') + ' ▾';
  document.title = '戲劇音樂播放台 — ' + scene().name;
}
function applyZoom() { document.documentElement.style.setProperty('--fs', ZOOMS[clamp(cfg.textSize | 0, 0, 2)][0] + 'px'); if (typeof fitGrid === 'function') requestAnimationFrame(fitGrid); }

function stopAll() { tracks.forEach(t => t.stop()); se.forEach(stopSe); }
$('#stopAll').onclick = stopAll;
$('#fadeAll').onclick = () => tracks.forEach(t => t.fadeOut());
$('#setBtn').onclick = () => settingsDialog();
$('#sceneBtn').onclick = () => sceneMenu();

function bindScene() {
  se.forEach(releaseSe);
  tracks.forEach(t => t.rebind());
  renderSe(); updateHeader(); saveSoon();
  preloadAll();
}
async function preloadAll() { for (const t of tracks) { try { await t.preload(); } catch (e) { } } }

function tickAll() { const now = performance.now(); for (const t of tracks) t.tick(now); for (const s of se) if (s.state === 'playing' && s.audio && s.audio.duration) s.bar.style.width = `calc(${(s.audio.currentTime / s.audio.duration) * 100}% - 8px)`; }

/* ------------------------------------------------------------------ dialogs */
let modalClose = null;
function openSheet(build, onClose) {
  const sh = $('#sheet'); sh.innerHTML = ''; sh.className = 'sheet';
  build(sh);
  $('#modal').hidden = false;
  modalClose = onClose || null;
}
function closeSheet() {
  $('#modal').hidden = true; $('#sheet').innerHTML = '';
  const f = modalClose; modalClose = null; if (f) f();
}
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeSheet(); });

function btn(text, cls, fn) { const b = el('button', 'b ' + (cls || ''), text); b.onclick = fn; return b; }
function row(labelText, ...nodes) { const r = el('div', 'row'); if (labelText != null) r.appendChild(el('label', null, labelText)); r.append(...nodes); return r; }
function textIn(v, cls) { const i = el('input', cls || ''); i.type = 'text'; i.value = v || ''; return i; }

function ask(title, value) {
  return new Promise(res => {
    let done = false;
    openSheet(sh => {
      sh.append(el('h2', null, title));
      const inp = textIn(value); sh.append(row(null, inp));
      const ok = () => { const v = inp.value.trim(); if (!v) return; done = true; closeSheet(); res(v); };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
      const b = el('div', 'btns'); b.append(btn('取消', '', () => closeSheet()), btn('確定', 'green', ok)); sh.append(b);
      setTimeout(() => { inp.focus(); inp.select(); }, 50);
    }, () => { if (!done) res(null); });
  });
}
function confirmBox(msg, yes) {
  return new Promise(res => {
    let done = false;
    openSheet(sh => {
      sh.append(el('h2', null, '確認'));
      const p = el('div', 'note'); p.style.whiteSpace = 'pre-line'; p.style.fontSize = '1em'; p.style.color = 'var(--text)'; p.textContent = msg; sh.append(p);
      const b = el('div', 'btns');
      b.append(btn('取消', '', () => closeSheet()), btn(yes || '確定', 'red', () => { done = true; closeSheet(); res(true); }));
      sh.append(b);
    }, () => { if (!done) res(false); });
  });
}
function info(title, msg) {
  $('#toast').hidden = true;
  openSheet(sh => {
    sh.append(el('h2', null, title));
    const p = el('div'); p.style.whiteSpace = 'pre-line'; p.textContent = msg; sh.append(p);
    const b = el('div', 'btns'); b.append(btn('好', 'green', () => closeSheet())); sh.append(b);
  });
}
let toastTimer = 0;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 3500); }

/** open the system file picker */
function pickFiles(accept, multiple) {
  return new Promise(res => {
    const old = $('#filePick');
    const inp = old.cloneNode(); old.replaceWith(inp);   // reset
    inp.accept = accept || ''; inp.multiple = !!multiple;
    inp.onchange = () => res(Array.from(inp.files || []));
    inp.click();
  });
}

function trackDialog(t) {
  if (t.active) { toast('此音軌使用中，請先停止再設定'); return; }
  const c = t.c;
  const d = { fileId: c.fileId, fileName: c.fileName };
  openSheet(sh => {
    sh.append(el('h2', null, `第 ${t.i + 1} 軌 設定`));
    const fn = el('div', 'fileName', d.fileName || '（尚未選擇）');
    const title = textIn(c.title);
    const pick = btn('選擇檔案', 'blue', async () => {
      const files = await pickFiles('audio/*,video/*', false);
      if (!files.length) return;
      const f = files[0];
      pick.disabled = true; pick.textContent = '讀取中…';
      try {
        const id = await storeFile(f, f.name);
        pendingIds.add(id);
        d.fileId = id; d.fileName = f.name; fn.textContent = f.name;
        if (!title.value.trim()) title.value = stem(f.name);
      } catch (e) { toast('無法儲存檔案：' + e.message); }
      pick.disabled = false; pick.textContent = '選擇檔案';
    });
    sh.append(row('檔案', fn, pick));
    sh.append(row('顯示名稱', title));
    const st = textIn(mmssF(c.start), 'short'), en = textIn(mmssF(c.end), 'short');
    sh.append(row('起點', st, el('label', null, '終點'), en));
    sh.append(el('div', 'note', '格式 分:秒，例如 1:23.5；空白＝從頭／到結尾'));
    const vol = textIn(String(c.volume), 'short'); vol.inputMode = 'numeric';
    const rep = el('input'); rep.type = 'checkbox'; rep.checked = !!c.repeat;
    const rl = el('label', 'chk'); rl.append(rep, document.createTextNode('循環播放'));
    sh.append(row('預設音量', vol, rl));
    const b = el('div', 'btns');
    b.append(
      btn('清除此軌', 'red', () => { d.fileId = ''; d.fileName = ''; fn.textContent = '（尚未選擇）'; title.value = ''; st.value = ''; en.value = ''; rep.checked = false; }),
      btn('取消', '', () => closeSheet()),
      btn('確定', 'green', () => {
        const s = parseTime(st.value), e = parseTime(en.value);
        if (s == null) { toast('起點格式不正確，例如 1:23.5'); return; }
        if (e == null) { toast('終點格式不正確，例如 3:45'); return; }
        if (e > 0 && e <= s) { toast('終點必須晚於起點'); return; }
        Object.assign(c, { fileId: d.fileId, fileName: d.fileName, title: title.value.trim(), start: s, end: e,
          volume: clamp(parseInt(vol.value, 10) || 0, 0, 100), repeat: rep.checked });
        pendingIds.clear();
        saveNow(); t.rebind(); t.preload();
        closeSheet();
      }));
    sh.append(b);
  }, () => { pendingIds.clear(); gcSoon(); });
}

function seDialog() {
  const sc = scene();
  const rows = sc.se.map(x => ({ ...x }));
  openSheet(sh => {
    sh.append(el('h2', null, '音效按鈕設定 — ' + sc.name));
    rows.forEach((r, i) => {
      const wrap = el('div', 'serow');
      const name = textIn(r.name); name.placeholder = '按鈕名稱';
      const fn = el('div', 'fn', r.fileName || '（未選檔）');
      const pick = btn('選檔', 'blue small', async () => {
        const files = await pickFiles('audio/*', false);
        if (!files.length) return;
        const f = files[0];
        try {
          const id = await storeFile(f, f.name); pendingIds.add(id);
          r.fileId = id; r.fileName = f.name; fn.textContent = f.name;
          if (!name.value.trim()) name.value = stem(f.name);
        } catch (e) { toast('無法儲存：' + e.message); }
      });
      const clr = btn('清除', 'small', () => { r.fileId = ''; r.fileName = ''; name.value = ''; fn.textContent = '（未選檔）'; });
      name.oninput = () => r.name = name.value;
      wrap.append(el('span', 'hint', String(i + 1)), name, pick, clr, fn);
      sh.append(wrap);
    });
    const b = el('div', 'btns');
    b.append(btn('取消', '', () => closeSheet()), btn('確定', 'green', () => {
      rows.forEach((r, i) => { sc.se[i] = { name: r.name.trim(), fileId: r.fileId, fileName: r.fileName }; });
      pendingIds.clear(); se.forEach(releaseSe); renderSe(); saveNow(); closeSheet();
    }));
    sh.append(b);
  }, () => { pendingIds.clear(); gcSoon(); });
}

function settingsDialog() {
  openSheet(sh => {
    sh.append(el('h2', null, '設定'));
    const fade = textIn(String(cfg.fadeSeconds), 'short'); fade.inputMode = 'numeric';
    sh.append(row('淡出秒數', fade));
    const sel = el('select'); ZOOMS.forEach((z, i) => { const o = el('option', null, z[1]); o.value = i; sel.appendChild(o); }); sel.value = cfg.textSize | 0;
    sh.append(row('文字大小', sel));
    const lay = el('select');
    [['auto', '自動（平板一頁全覽，手機清單）'], ['fit', '一頁全覽（20 軌一次看到）'], ['list', '清單（大按鈕）']].forEach(x => { const o = el('option', null, x[1]); o.value = x[0]; lay.appendChild(o); });
    lay.value = cfg.layout || 'auto';
    sh.append(row('版面', lay));
    const st = el('div', 'note', '計算儲存空間中…'); sh.append(st);
    if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(e => { st.textContent = '已使用儲存空間：約 ' + Math.round((e.usage || 0) / 1048576) + ' MB'; }).catch(() => st.textContent = '');
    else st.textContent = '';
    sh.append(el('div', 'note', '戲劇音樂播放台 手機版 v' + VERSION + '\n音樂檔會存在 App 裡，刪除 App 會一併刪除。'));
    const b = el('div', 'btns');
    b.append(btn('取消', '', () => closeSheet()), btn('確定', 'green', () => {
      cfg.fadeSeconds = clamp(parseInt(fade.value, 10) || 3, 1, 30);
      cfg.textSize = +sel.value; cfg.layout = lay.value; applyZoom(); applyLayout(); saveNow(); closeSheet();
    }));
    sh.append(b);
  });
}

function sceneMenu() {
  openSheet(sh => {
    sh.append(el('h2', null, '場次'));
    const m = el('div', 'menu');
    cfg.scenes.forEach((s, i) => {
      const b = btn((i === cfg.current ? '● ' : '　') + (i + 1) + '. ' + s.name, i === cfg.current ? 'cur' : '', () => { closeSheet(); switchScene(i); });
      m.append(b);
    });
    m.append(el('hr'));
    const add = (t, f) => m.append(btn(t, '', () => { closeSheet(); f(); }));
    add('＋ 新增場次（空白音軌，沿用目前音效）', newSceneCmd);
    add('複製目前場次', copySceneCmd);
    add('重新命名目前場次', renameSceneCmd);
    add('上移目前場次', () => moveScene(-1));
    add('下移目前場次', () => moveScene(1));
    add('刪除目前場次', deleteSceneCmd);
    m.append(el('hr'));
    add('⇩ 匯入電腦版場次（.zip 或多個檔案）…', importCmd);
    sh.append(m);
  });
}

async function confirmStop() {
  if (!tracks.some(t => t.active)) return true;
  return confirmBox('目前有音軌正在播放，切換會全部停止，確定嗎？', '停止並繼續');
}
async function switchScene(i) {
  if (i < 0 || i >= cfg.scenes.length || i === cfg.current) return;
  if (!(await confirmStop())) return;
  stopAll(); cfg.current = i; bindScene();
}
async function newSceneCmd() {
  const n = await ask('新增場次', '場次 ' + (cfg.scenes.length + 1)); if (!n) return;
  if (!(await confirmStop())) return;
  stopAll();
  const s = newScene(n); s.se = JSON.parse(JSON.stringify(scene().se));
  cfg.scenes.push(s); cfg.current = cfg.scenes.length - 1; bindScene();
}
async function copySceneCmd() {
  const n = await ask('複製場次', scene().name + ' 複本'); if (!n) return;
  if (!(await confirmStop())) return;
  stopAll();
  cfg.scenes.splice(cfg.current + 1, 0, cloneScene(scene(), n)); cfg.current++; bindScene();
}
async function renameSceneCmd() {
  const n = await ask('重新命名場次', scene().name); if (!n) return;
  scene().name = n; updateHeader(); saveSoon();
}
function moveScene(d) {
  const i = cfg.current, j = i + d; if (j < 0 || j >= cfg.scenes.length) return;
  [cfg.scenes[i], cfg.scenes[j]] = [cfg.scenes[j], cfg.scenes[i]]; cfg.current = j; updateHeader(); saveSoon();
}
async function deleteSceneCmd() {
  if (cfg.scenes.length <= 1) { toast('至少要保留一個場次'); return; }
  if (!(await confirmBox(`確定刪除場次「${scene().name}」？\n（場次裡的音樂檔也會從 App 中移除）`, '刪除'))) return;
  stopAll();
  cfg.scenes.splice(cfg.current, 1); cfg.current = Math.min(cfg.current, cfg.scenes.length - 1); bindScene();
}

/* ------------------------------------------------------------------ import from the PC version */
function parseIni(text) {
  text = text.replace(/^﻿/, '');
  const scenes = []; let sec = '';
  const at = n => { while (scenes.length <= n) scenes.push({ name: '場次 ' + (scenes.length + 1), tracks: Array.from({ length: TRACKS }, newTrack), se: Array.from({ length: SES }, newSe), _files: {} }); return scenes[n]; };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    const m = line.match(/^\[(.+)\]$/); if (m) { sec = m[1]; continue; }
    const eq = line.indexOf('='); if (eq < 0) continue;
    const k = line.slice(0, eq).trim(), v = line.slice(eq + 1);
    const sm = sec.match(/^Scene(\d+)(?:\.(Track|SE)(\d+))?$/); if (!sm) continue;
    const sc = at(+sm[1] - 1);
    if (!sm[2]) { if (k === 'Name') sc.name = v; continue; }
    const n = +sm[3] - 1;
    if (sm[2] === 'Track' && n >= 0 && n < TRACKS) {
      const t = sc.tracks[n];
      if (k === 'File') t._path = v; else if (k === 'Title') t.title = v;
      else if (k === 'Start') t.start = parseFloat(v) || 0; else if (k === 'End') t.end = parseFloat(v) || 0;
      else if (k === 'Volume') t.volume = clamp(parseInt(v, 10) || 80, 0, 100); else if (k === 'Repeat') t.repeat = v === '1';
    } else if (sm[2] === 'SE' && n >= 0 && n < SES) {
      const e = sc.se[n]; if (k === 'Name') e.name = v; else if (k === 'File') e._path = v;
    }
  }
  return scenes;
}

function decodeZipName(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (e) { try { return new TextDecoder('big5').decode(bytes); } catch (e2) { return String.fromCharCode.apply(null, bytes); } }
}

async function importCmd() {
  const files = await pickFiles('', true);
  if (!files.length) return;
  toast('匯入中，請稍候…');
  try {
    // sources: name(lower, normalised path) -> {get: () => Promise<Blob>, name}
    const byPath = new Map(), byBase = new Map();
    const iniTexts = [];
    const addSrc = (path, name, get) => {
      const p = path.replace(/\\/g, '/').toLowerCase();
      const src = { name, get };
      byPath.set(p, src);
      const b = baseName(p); if (!byBase.has(b)) byBase.set(b, src);
    };
    for (const f of files) {
      const lower = f.name.toLowerCase();
      if (lower.endsWith('.zip')) {
        const zip = await JSZip.loadAsync(f, { decodeFileName: decodeZipName });
        const entries = [];
        zip.forEach((p, e) => { if (!e.dir) entries.push([p, e]); });
        for (const [p, e] of entries) {
          const l = p.toLowerCase();
          if (l.endsWith('.vpscene') || baseName(l) === 'settings.ini') iniTexts.push({ text: await e.async('string'), dir: p.replace(/[^/]*$/, '') });
          else addSrc(p, baseName(p), () => e.async('blob'));
        }
      } else if (lower.endsWith('.vpscene') || lower === 'settings.ini') {
        iniTexts.push({ text: await f.text(), dir: '' });
      } else addSrc(f.name, f.name, () => Promise.resolve(f));
    }
    if (!iniTexts.length) { info('匯入場次', '沒有找到場次檔（.vpscene）。\n\n請在電腦版按「場次 > 匯出全部場次」或「匯出成可攜版」，把產生的資料夾壓縮成 zip（右鍵 > 傳送到 > 壓縮的資料夾），再把 zip 傳到手機匯入。'); return; }

    const stored = new Map(); let missing = [], added = [];
    const resolve = async (path, dir) => {
      if (!path) return null;
      const norm = path.replace(/\\/g, '/');
      const b = baseName(norm).toLowerCase();
      let src = byPath.get((dir + norm).toLowerCase()) || byPath.get(norm.toLowerCase()) || byBase.get(b);
      if (src) {
        const key = src.name + '|' + b;
        if (stored.has(key)) return stored.get(key);
        const blob = await src.get();
        const typed = blob.type ? blob : new Blob([blob], { type: guessType(b) });
        const id = await storeFile(typed, src.name);
        const r = { fileId: id, fileName: src.name }; stored.set(key, r); return r;
      }
      if (BUILTIN_NAMES.includes(b)) { const real = BUILTIN_SE.find(x => x[1].toLowerCase() === b)[1]; return { fileId: 'builtin:' + real, fileName: real }; }
      missing.push(baseName(norm)); return null;
    };
    for (const it of iniTexts) {
      for (const sc of parseIni(it.text)) {
        for (const t of sc.tracks) { if (t._path) { const r = await resolve(t._path, it.dir); if (r) Object.assign(t, r); } delete t._path; }
        for (const e of sc.se) { if (e._path) { const r = await resolve(e._path, it.dir); if (r) Object.assign(e, r); } delete e._path; }
        delete sc._files;
        let n = sc.name, k = 2; while (cfg.scenes.some(x => x.name === n) || added.some(x => x.name === n)) n = sc.name + ` (${k++})`;
        sc.name = n; added.push(sc);
      }
    }
    if (!added.length) { toast('場次檔裡沒有場次'); return; }
    if (!(await confirmStop())) return;
    stopAll();
    const first = cfg.scenes.length;
    cfg.scenes.push(...added); cfg.current = first; saveNow(); bindScene();
    let msg = `已匯入 ${added.length} 個場次：\n` + added.map(s => '．' + s.name).join('\n');
    missing = [...new Set(missing)];
    if (missing.length) msg += `\n\n有 ${missing.length} 個檔案沒有在 zip 裡，對應的音軌會是空的：\n` + missing.slice(0, 8).join('\n') + (missing.length > 8 ? '\n…' : '');
    info('匯入完成', msg);
  } catch (e) {
    info('匯入失敗', '無法讀取檔案：' + (e.message || e) + '\n\n請確認選的是電腦版匯出資料夾壓縮成的 zip。');
  }
}
function guessType(n) {
  const e = n.split('.').pop();
  return ({ mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac', wma: 'audio/x-ms-wma',
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', '3gp': 'video/3gpp', mkv: 'video/x-matroska' })[e] || '';
}

/* ------------------------------------------------------------------ Android back button */
window.handleBack = function () {
  if (!$('#modal').hidden) { closeSheet(); return true; }
  if (!$('#videoLayer').hidden) { if (videoOwner) videoOwner.stop(); else hideVideo(); return true; }
  return false;
};

/* keep the screen on (browser version; the Android app does this natively) */
let wake = null;
async function keepAwake() { try { if ('wakeLock' in navigator && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => wake = null); } } catch (e) { } }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });
document.addEventListener('pointerdown', keepAwake, { once: true });

/* ------------------------------------------------------------------ web app (iPhone / iPad / browsers) */
function setupWebApp() {
  if (!/^https?:/.test(location.protocol)) return;          // inside the Android app: nothing to do
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js?v=' + VERSION).catch(() => { });
  }
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (ios && !standalone && localStorage.getItem('dp_hideInstall') !== '1') {
    setTimeout(() => {
      openSheet(sh => {
        sh.append(el('h2', null, '請先加入主畫面'));
        const p = el('div'); p.style.whiteSpace = 'pre-line';
        p.textContent = '在 iPhone／iPad 上，請用 Safari：\n\n1. 按「分享」按鈕（方框加向上箭頭）\n2. 選「加入主畫面」\n3. 之後從主畫面的「戲劇音樂播放台」圖示開啟\n\n這樣才能全螢幕使用，選進來的音樂也比較不會被系統清除。';
        sh.append(p);
        const b = el('div', 'btns');
        b.append(btn('不再提示', '', () => { localStorage.setItem('dp_hideInstall', '1'); closeSheet(); }), btn('知道了', 'green', () => closeSheet()));
        sh.append(b);
      });
    }, 600);
  }
}

/* ------------------------------------------------------------------ start */
(async function init() {
  $('#ver').textContent = 'v' + VERSION;
  loadCfg(); applyZoom();
  try { await DB.open(); } catch (e) { info('錯誤', '無法開啟儲存空間：' + e.message); }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });
  buildTracks(); buildSe();
  tracks.forEach(t => t.render()); renderSe(); updateHeader(); applyLayout();
  setInterval(tickAll, 100);
  setupWebApp();
  preloadAll();
  gcSoon();
})();
