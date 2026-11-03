import { MOODS, tagsOf, dayKey, shiftDay, streak, weekDays, matches, peaks, takeRemote, mediaPaths, fmtDuration, journalDay, entryDay } from './logic.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON = {
  play: '<svg class="i" viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>',
  pause: '<svg class="i" viewBox="0 0 24 24"><path d="M7 4v16M17 4v16"/></svg>',
  stop: '<svg class="i" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12"/></svg>',
  mic: '<svg class="i" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  x: '<svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};
const PROMPTS = [
  'What took up most of your head today?', 'What are you avoiding?', 'What did you say yes to that you meant no?',
  'Who did you think about today, and why?', 'What would you do tomorrow if nobody was watching?',
  'What is the thing you keep almost saying?', 'What drained you today?', 'What gave you a bit of energy back?',
  'What are you pretending not to know?', 'What did your body try to tell you today?', 'What are you proud of that nobody saw?',
  'What is one thing you would undo?', 'What are you waiting for permission to do?', 'Where did your money and time actually go?',
  'What scared you a little today?', 'What do you want more of this week?', 'What would the 10-years-older you say about today?',
  'What is unfinished and bothering you?', 'What made you laugh?', 'What do you need to forgive yourself for?',
];

// ---------- local store (IndexedDB is the source of truth on each device) ----------
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('mindbank', 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore('items', { keyPath: 'id' });
    r.result.createObjectStore('media', { keyPath: 'path' });
    r.result.createObjectStore('meta');
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function tx(name, mode, fn) {
  const d = await dbp;
  return new Promise((res, rej) => {
    const t = d.transaction(name, mode), req = fn(t.objectStore(name));
    t.oncomplete = () => res(req?.result);
    t.onerror = t.onabort = () => rej(t.error);
  });
}
const idb = {
  all: n => tx(n, 'readonly', s => s.getAll()),
  get: (n, k) => tx(n, 'readonly', s => s.get(k)),
  put: (n, v, k) => tx(n, 'readwrite', s => s.put(v, k)),
  del: (n, k) => tx(n, 'readwrite', s => s.delete(k)),
};

let rows = new Map(); // id -> {id, kind, data, updated_at, deleted, dirty}
const live = kind => [...rows.values()].filter(r => r.kind === kind && !r.deleted);

async function save(row) {
  row = { ...row, updated_at: new Date().toISOString(), dirty: 1 };
  await idb.put('items', row);
  rows.set(row.id, row);
  render();
  sync();
  return row;
}

const urls = new Map(); // media path -> object URL
async function mediaBlob(path) {
  let m = await idb.get('media', path);
  if (!m && sb && user && navigator.onLine) {
    const { data, error } = await sb.storage.from('media').download(`${user.id}/${path}`);
    if (!error) await idb.put('media', m = { path, blob: data, uploaded: 1 });
  }
  return m?.blob || null;
}
async function mediaUrl(path) {
  if (!urls.has(path)) {
    const b = await mediaBlob(path);
    if (!b) return null;
    urls.set(path, URL.createObjectURL(b));
  }
  return urls.get(path);
}

// ---------- sync (Supabase, optional) ----------
let sb = null, user = null, syncing = false, again = false;

function setStatus(s, text) { const el = $('#status'); el.dataset.s = s; el.textContent = text; }
function idleStatus() {
  if (!sb) return setStatus('local', 'local only: saved on this device, not synced');
  if (!navigator.onLine) return setStatus('offline', 'offline: saved on this device, syncs when back');
}

async function sync() {
  if (!sb || !user) return idleStatus();
  if (!navigator.onLine) return idleStatus();
  if (syncing) { again = true; return; }
  syncing = true;
  setStatus('syncing', 'syncing...');
  try {
    const dirty = [...rows.values()].filter(r => r.dirty);
    // media first, so another device never sees an entry whose files are missing
    for (const r of dirty) {
      if (r.kind !== 'entry') continue;
      const paths = mediaPaths(r.data);
      if (r.deleted) {
        if (paths.length) {
          const { error } = await sb.storage.from('media').remove(paths.map(p => `${user.id}/${p}`));
          if (error) throw error;
        }
        continue;
      }
      for (const p of paths) {
        const m = await idb.get('media', p);
        if (!m || m.uploaded) continue;
        const { error } = await sb.storage.from('media').upload(`${user.id}/${p}`, m.blob, { upsert: true, contentType: m.blob.type });
        if (error) throw error;
        await idb.put('media', { ...m, uploaded: 1 });
      }
    }
    if (dirty.length) {
      // shortcut: server keeps whichever device pushed last; fine for one person, add a version check if edits ever collide
      const { error } = await sb.from('items').upsert(dirty.map(({ id, kind, data, updated_at, deleted }) => ({ id, kind, data, updated_at, deleted })));
      if (error) throw error;
      for (const r of dirty) {
        const cur = rows.get(r.id);
        if (cur.updated_at === r.updated_at) { cur.dirty = 0; await idb.put('items', cur); }
      }
    }
    // pull: synced_at is server time, so device clocks don't matter; the 60s overlap catches late commits and re-merging is harmless
    const since = (await idb.get('meta', 'lastPull')) || '1970-01-01T00:00:00Z';
    const from = new Date(Date.parse(since) - 60000).toISOString();
    let max = since, changed = false;
    for (let page = 0; ; page++) {
      const { data, error } = await sb.from('items').select('id,kind,data,updated_at,deleted,synced_at')
        .gt('synced_at', from).order('synced_at').range(page * 1000, page * 1000 + 999);
      if (error) throw error;
      for (const r of data) {
        if (Date.parse(r.synced_at) > Date.parse(max)) max = r.synced_at;
        const local = rows.get(r.id);
        if (!takeRemote(local, r) || (local && !local.dirty && Date.parse(local.updated_at) === Date.parse(r.updated_at))) continue;
        const row = { id: r.id, kind: r.kind, data: r.data, updated_at: r.updated_at, deleted: r.deleted, dirty: 0 };
        await idb.put('items', row);
        rows.set(row.id, row);
        if (row.deleted && row.kind === 'entry') for (const p of mediaPaths(row.data)) await idb.del('media', p);
        changed = true;
      }
      if (data.length < 1000) break;
    }
    await idb.put('meta', max, 'lastPull');
    if (changed) render();
    setStatus('synced', 'synced ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  } catch (e) {
    setStatus('error', 'not synced yet: ' + (e.message || e) + ' (your notes are safe on this device)');
  } finally {
    syncing = false;
    if (again) { again = false; sync(); }
  }
}

async function initRemote() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return idleStatus();
  try {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
    sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch {
    $('#lock').hidden = true;
    return setStatus('offline', 'offline: sync code not loaded yet, saving on this device');
  }
  const { data: { session } } = await sb.auth.getSession();
  user = session?.user || null;
  showLock();
  sb.auth.onAuthStateChange((_e, s) => { user = s?.user || null; showLock(); if (user) sync(); });
  sync();
}
function showLock() {
  $('#lock').hidden = !!user;
  $('#signout').hidden = !user;
}
$('#lock-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('#lock-msg').textContent = '';
  const { error } = await sb.auth.signInWithPassword({ email: $('#lock-email').value.trim(), password: $('#lock-pass').value });
  if (error) $('#lock-msg').textContent = error.message;
  $('#lock-pass').value = '';
});
$('#signout').addEventListener('click', async () => {
  if ([...rows.values()].some(r => r.dirty)) return flash('Wait for sync to finish before signing out.');
  await sb.auth.signOut();
});

// ---------- state ----------
const ui = { entryDayPicked: false, q: '', day: null, limit: 30, prompt: PROMPTS[Math.floor(Date.now() / 864e5) % PROMPTS.length] };
const draft = { photos: [], audio: null, mood: null };

// ---------- render ----------
function textHTML(t) { return esc(t).replace(/#([\p{L}\p{N}_-]+)/gu, '<mark class="tag">#$1</mark>'); }
function waveHTML(peaksArr) { return peaksArr.map(p => `<i style="height:${Math.max(8, p * 100)}%"></i>`).join(''); }
const fmtDay = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: new Date().getFullYear() === y ? undefined : 'numeric' }); };

function entryHTML(r) {
  const d = r.data, t = new Date(d.created_at), day = entryDay(r);
  const clock = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const written = dayKey(t) !== day ? `<span class="written">written ${esc(fmtDay(dayKey(t)))}, ${esc(clock)}</span>` : `<span class="written">${esc(clock)}</span>`;
  return `<article class="card entry">
    <header class="entry-head">
      <input class="entry-date" type="date" data-move="${r.id}" value="${day}" max="${dayKey(new Date())}" aria-label="Entry date, tap to change">
      ${written}
      <span class="chip kind">${d.audio ? 'voice' : 'note'}</span>
      ${d.mood ? `<span class="chip">${esc(d.mood)}</span>` : ''}
      <button class="btn icon-btn btn-ghost del" type="button" data-del-entry="${r.id}" aria-label="Delete entry">${ICON.x}</button>
    </header>
    ${d.prompt ? `<p class="entry-prompt">${esc(d.prompt)}</p>` : ''}
    ${d.audio ? `<div class="voice">
      <button class="btn icon-btn" type="button" data-play="${r.id}" aria-label="Play voice note">${player.id === r.id && !audioEl.paused ? ICON.pause : ICON.play}</button>
      <div class="wave" data-wave="${r.id}">${waveHTML(d.audio.peaks || [])}</div>
      <small>${fmtDuration(d.audio.duration)}</small></div>` : ''}
    ${d.transcript ? `<p class="transcript">${esc(d.transcript)}</p>` : ''}
    ${d.text ? `<p class="text">${textHTML(d.text)}</p>` : ''}
    ${d.photos?.length ? `<div class="polaroids">${d.photos.map(p => `<figure class="polaroid"><img data-media="${esc(p)}" alt="Photo from this entry" loading="lazy"${urls.has(p) ? ` src="${urls.get(p)}"` : ''}></figure>`).join('')}</div>` : ''}
    ${d.tags?.length ? `<div class="entry-tags">${d.tags.map(g => `<button class="tag-btn" type="button" data-tag="${esc(g)}">#${esc(g)}</button>`).join('')}</div>` : ''}
  </article>`;
}

function render() {
  const tasks = live('task'), entries = live('entry');

  // to-dos
  const shownTasks = tasks.filter(r => matches(r, ui.q))
    .sort((a, b) => a.data.done - b.data.done || (a.data.done ? b.data.done_at?.localeCompare(a.data.done_at) : a.data.created_at.localeCompare(b.data.created_at)));
  const open = tasks.filter(r => !r.data.done).length;
  $('#task-count').textContent = `${open} open · ${tasks.length - open} done`;
  $('#tasks').innerHTML = shownTasks.map(r => `<li class="${r.data.done ? 'done' : ''}">
      <label><input type="checkbox" data-toggle="${r.id}" ${r.data.done ? 'checked' : ''}><span>${esc(r.data.text)}</span></label>
      <button class="btn icon-btn btn-ghost del" type="button" data-del-task="${r.id}" aria-label="Delete task: ${esc(r.data.text)}">${ICON.x}</button>
    </li>`).join('') || `<li class="empty">${ui.q ? 'No tasks match.' : 'Nothing to do. Add one above.'}</li>`;

  // the bank: tag cloud
  const counts = {};
  for (const r of entries) for (const g of r.data.tags || []) counts[g] = (counts[g] || 0) + 1;
  const active = ui.q.toLowerCase().split(/\s+/);
  $('#tags').innerHTML = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([g, n]) => `<button class="tag-btn" type="button" data-tag="${esc(g)}" aria-pressed="${active.includes('#' + g)}">#${esc(g)}<small>${n}</small></button>`).join('')
    || '<span class="empty">Tags show up here. Write #something in an entry.</span>';

  // entries
  const shown = entries.filter(r => matches(r, ui.q) && (!ui.day || entryDay(r) === ui.day))
    .sort((a, b) => entryDay(b).localeCompare(entryDay(a)) || b.data.created_at.localeCompare(a.data.created_at));
  $('#day').value = ui.day || '';
  $('#entries-title').textContent = (ui.day ? fmtDay(ui.day) : 'everything banked') + (ui.q ? ` matching "${ui.q}"` : '') + ` (${shown.length})`;
  $('#entries').innerHTML = shown.slice(0, ui.limit).map(entryHTML).join('')
    || `<p class="empty">${entries.length ? 'Nothing here for that search or day.' : 'Nothing banked yet. Record, write or add a photo above, then press Bank it.'}</p>`;
  $('#more').hidden = shown.length <= ui.limit;
  hydrateMedia();
  paintProgress();

  // rhythm
  const n = streak(entries);
  $('#streak-n').textContent = n;
  $('#streak-label').textContent = n === 1 ? 'day in a row' : 'days in a row';
  const perDay = {};
  for (const r of entries) { const k = entryDay(r); perDay[k] = (perDay[k] || 0) + 1; }
  const today = journalDay();
  $('#week').innerHTML = weekDays().map(k => {
    const c = perDay[k] || 0, label = new Date(k + 'T12:00').toLocaleDateString([], { weekday: 'short' });
    return `<button type="button" data-day="${k}" data-l="${Math.min(c, 3)}" class="${k === today ? 'today' : ''}" aria-pressed="${ui.day === k}" aria-label="${fmtDay(k)}: ${c} ${c === 1 ? 'entry' : 'entries'}"><b>${label.slice(0, 2)}</b><span></span></button>`;
  }).join('');
  const photos = entries.reduce((s, r) => s + (r.data.photos?.length || 0), 0);
  const voice = entries.reduce((s, r) => s + (r.data.audio?.duration || 0), 0);
  $('#totals').innerHTML = [['entries', entries.length], ['photos', photos], ['voice time', fmtDuration(voice)], ['tasks done', tasks.length - open]]
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}

async function hydrateMedia() {
  for (const img of document.querySelectorAll('img[data-media]:not([src])')) {
    const u = await mediaUrl(img.dataset.media);
    if (u) img.src = u; else img.alt = 'Photo not downloaded yet (offline)';
  }
}

// ---------- audio playback (entries and the unsaved draft share one player) ----------
const audioEl = new Audio();
const player = { id: null };
function paintProgress() {
  const wave = player.id && document.querySelector(`[data-wave="${player.id}"]`);
  if (!wave) return;
  const p = audioEl.duration && isFinite(audioEl.duration) ? audioEl.currentTime / audioEl.duration : 0;
  [...wave.children].forEach((b, i, all) => b.classList.toggle('on', i / all.length < p));
}
function paintButtons() {
  for (const b of document.querySelectorAll('[data-play]')) {
    const on = b.dataset.play === player.id && !audioEl.paused;
    b.innerHTML = on ? ICON.pause : ICON.play;
    b.setAttribute('aria-label', on ? 'Pause' : 'Play voice note');
  }
}
audioEl.addEventListener('timeupdate', paintProgress);
audioEl.addEventListener('play', paintButtons);
audioEl.addEventListener('pause', paintButtons);
audioEl.addEventListener('ended', () => { paintButtons(); });
async function togglePlay(id) {
  if (player.id === id && !audioEl.paused) return audioEl.pause();
  if (player.id !== id) {
    const src = id === 'draft' ? draft.audio?.url : await mediaUrl(rows.get(id).data.audio.path);
    if (!src) return flash('That recording is not on this device yet. Go online to fetch it.');
    document.querySelectorAll('.wave i.on').forEach(b => b.classList.remove('on'));
    player.id = id;
    audioEl.src = src;
  }
  audioEl.play().catch(() => flash('This browser cannot play that recording format.'));
}

// ---------- recording ----------
// No live transcript: browser speech recognition grabs the microphone on iPhone and cut recordings off after about a minute.
// No time limit. Pause/resume, screen kept awake, and anything recorded is kept if the phone locks or the mic is taken.
const rec = { mr: null, stream: null, tick: null, start: 0, pausedMs: 0, pauseAt: 0, levels: [], ac: null, wl: null, stopNote: '' };
const recording = () => rec.mr && rec.mr.state !== 'inactive';
const elapsed = () => Math.max(0, (Date.now() - rec.start - rec.pausedMs - (rec.mr?.state === 'paused' ? Date.now() - rec.pauseAt : 0)) / 1000);

async function keepAwake() {
  try { rec.wl = await navigator.wakeLock?.request('screen'); } catch { rec.wl = null; }
}

async function startRec() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return flash('This browser cannot record audio.');
  let stream;
  try { stream = rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch { return flash('Microphone blocked. Allow it for this site in your browser settings, then try again.'); }
  discardAudio();
  // AAC in mp4 first: it plays on iPhone and Android/desktop alike
  const mime = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(m => MediaRecorder.isTypeSupported(m));
  const mr = rec.mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  rec.levels = []; rec.pausedMs = 0; rec.stopNote = '';
  mr.ondataavailable = e => e.data.size && chunks.push(e.data);
  mr.onstop = () => {
    const duration = elapsed();
    stream.getTracks().forEach(t => t.stop());
    rec.ac?.close();
    clearInterval(rec.tick);
    rec.wl?.release?.().catch(() => {}); rec.wl = null;
    rec.mr = null;
    $('#rec-pause').hidden = true;
    if (!chunks.length) { setRecButton(false); return flash('Nothing was recorded. Try again.'); }
    const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
    setDraftAudio({ blob, duration, peaks: peaks(rec.levels) });
    persistDraftAudio();
    setRecButton(false);
    if (rec.stopNote) flash(rec.stopNote);
  };
  // if the phone locks, a call comes in or another app takes the mic, keep what was said so far
  stream.getAudioTracks().forEach(t => t.addEventListener('ended', () => {
    if (recording()) { rec.stopNote = 'Recording stopped because the microphone was interrupted. Everything up to that point is kept.'; stopRec(); }
  }));
  try {
    rec.ac = new AudioContext();
    const an = rec.ac.createAnalyser();
    an.fftSize = 1024;
    rec.ac.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    rec.read = () => { an.getByteTimeDomainData(buf); let s = 0; for (const v of buf) s += ((v - 128) / 128) ** 2; return Math.sqrt(s / buf.length); };
  } catch { rec.read = () => 0.5; }
  rec.start = Date.now();
  rec.tick = setInterval(() => {
    if (rec.mr?.state !== 'recording') return;
    rec.levels.push(rec.read());
    $('#rec-time').textContent = fmtDuration(elapsed());
  }, 100);
  mr.start(1000);
  keepAwake();
  $('#rec-pause').hidden = false;
  $('#rec-pause').textContent = 'Pause';
  setRecButton(true);
}
function stopRec() {
  if (!recording()) return;
  if (rec.mr.state === 'paused') { rec.pausedMs += Date.now() - rec.pauseAt; rec.pauseAt = Date.now(); }
  rec.mr.stop();
}
function togglePause() {
  if (!recording()) return;
  if (rec.mr.state === 'recording') {
    rec.mr.pause(); rec.pauseAt = Date.now();
    $('#rec-pause').textContent = 'Resume';
    $('#rec').querySelector('span').textContent = 'Stop (paused)';
  } else {
    rec.pausedMs += Date.now() - rec.pauseAt;
    rec.mr.resume();
    $('#rec-pause').textContent = 'Pause';
    setRecButton(true);
  }
}
let replaceArmed = false, replaceTimer;
function setRecButton(on) {
  const b = $('#rec');
  b.setAttribute('aria-pressed', on);
  replaceArmed = false;
  b.innerHTML = on ? `${ICON.stop}<span>Stop</span>` : `${ICON.mic}<span>${draft.audio ? 'Record again' : 'Record'}</span>`;
}
function onRecClick() {
  if (recording()) return stopRec();
  // a second recording replaces the first, so ask once before throwing a long recording away
  if (draft.audio && !replaceArmed) {
    replaceArmed = true;
    $('#rec').querySelector('span').textContent = 'Tap again to replace';
    clearTimeout(replaceTimer);
    replaceTimer = setTimeout(() => !recording() && setRecButton(false), 3000);
    return;
  }
  startRec();
}
function setDraftAudio(a) {
  if (draft.audio) URL.revokeObjectURL(draft.audio.url);
  draft.audio = { ...a, url: URL.createObjectURL(a.blob) };
  $('#rec-preview').hidden = false;
  $('[data-wave="draft"]').innerHTML = waveHTML(draft.audio.peaks);
  $('#rec-time').textContent = fmtDuration(draft.audio.duration);
  paintButtons();
}
// an unbanked recording survives a reload or the app being closed
function persistDraftAudio() {
  const a = draft.audio;
  idb.put('meta', a ? { blob: a.blob, duration: a.duration, peaks: a.peaks } : null, 'draftAudio').catch(() => {});
}
function discardAudio() {
  if (player.id === 'draft') { audioEl.pause(); player.id = null; }
  if (draft.audio) URL.revokeObjectURL(draft.audio.url);
  draft.audio = null;
  persistDraftAudio();
  $('#rec-preview').hidden = true;
  $('#rec-time').textContent = '0:00';
  setRecButton(false);
}

// ---------- photos ----------
async function shrink(file) {
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(), 'image/jpeg', 0.85));
  } catch { return file; } // e.g. HEIC outside Safari: keep the original
}
function renderDraftPhotos() {
  $('#photo-preview').innerHTML = draft.photos.map((p, i) =>
    `<figure class="polaroid"><img src="${p.url}" alt="Photo to attach"><button class="btn icon-btn x" type="button" data-unphoto="${i}" aria-label="Remove photo">${ICON.x}</button></figure>`).join('');
}

// ---------- composer ----------
let flashTimer;
function flash(msg) { $('#composer-msg').textContent = msg; clearTimeout(flashTimer); flashTimer = setTimeout(() => $('#composer-msg').textContent = '', 5000); }

async function bankIt() {
  if (recording()) { stopRec(); for (let i = 0; i < 30 && recording(); i++) await new Promise(r => setTimeout(r, 100)); await new Promise(r => setTimeout(r, 100)); }
  const text = $('#entry-text').value.trim();
  if (!text && !draft.audio && !draft.photos.length) return flash('Say, write or add a photo first.');
  const day = $('#entry-day').value || journalDay();
  if (day > dayKey(new Date())) return flash('That date is in the future. Pick today or earlier.');
  const btn = $('#bank');
  btn.disabled = true;
  try {
    const id = crypto.randomUUID();
    let audio = null;
    if (draft.audio) {
      const ext = draft.audio.blob.type.includes('mp4') ? 'm4a' : draft.audio.blob.type.includes('ogg') ? 'ogg' : 'webm';
      audio = { path: `${id}/voice.${ext}`, duration: Math.round(draft.audio.duration), peaks: draft.audio.peaks };
      await idb.put('media', { path: audio.path, blob: draft.audio.blob, uploaded: 0 });
      urls.set(audio.path, draft.audio.url);
    }
    const photos = [];
    for (const [i, p] of draft.photos.entries()) {
      const path = `${id}/photo-${i + 1}.${p.blob.type === 'image/jpeg' ? 'jpg' : (p.blob.type.split('/')[1] || 'img')}`;
      await idb.put('media', { path, blob: p.blob, uploaded: 0 });
      urls.set(path, p.url);
      photos.push(path);
    }
    await save({ id, kind: 'entry', deleted: false, data: { created_at: new Date().toISOString(), day, mood: draft.mood, prompt: ui.prompt, text, tags: tagsOf(text), audio, photos } });
    if (player.id === 'draft') { audioEl.pause(); player.id = null; }
    draft.audio = null; draft.photos = []; draft.mood = null;
    persistDraftAudio();
    $('#entry-text').value = '';
    ui.entryDayPicked = false;
    setEntryDay();
    $('#rec-preview').hidden = true;
    $('#rec-time').textContent = '0:00';
    document.querySelectorAll('[name=mood]').forEach(r => r.checked = false);
    setRecButton(false);
    renderDraftPhotos();
    try { localStorage.removeItem('mb-draft'); } catch { /* storage blocked */ }
    flash(`Banked under ${fmtDay(day)}.`);
  } catch (e) {
    flash('Could not save: ' + (e.message || e) + '. Your entry is still here.');
  } finally { btn.disabled = false; }
}

// ---------- export ----------
async function exportAll() {
  const btn = $('#export');
  btn.disabled = true;
  try {
    const { default: JSZip } = await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm');
    const zip = new JSZip(), entries = live('entry').sort((a, b) => entryDay(a).localeCompare(entryDay(b)) || a.data.created_at.localeCompare(b.data.created_at)), tasks = live('task');
    let missing = 0;
    for (const r of entries) for (const p of mediaPaths(r.data)) {
      const b = await mediaBlob(p);
      b ? zip.file('media/' + p, b) : missing++;
    }
    zip.file('mind-bank.json', JSON.stringify({ exported_at: new Date().toISOString(), tasks: tasks.map(r => ({ id: r.id, ...r.data })), entries: entries.map(r => ({ id: r.id, ...r.data })) }, null, 2));
    zip.file('journal.txt', entries.map(r => {
      const d = r.data;
      return [`== ${fmtDay(entryDay(r))} (written ${new Date(d.created_at).toLocaleString()})${d.mood ? ' · ' + d.mood : ''}`, d.prompt && `> ${d.prompt}`, d.transcript && `[said] ${d.transcript}`, d.text,
        ...mediaPaths(d).map(p => `[file] media/${p}`)].filter(Boolean).join('\n');
    }).join('\n\n') + '\n\nTASKS\n' + tasks.map(r => `[${r.data.done ? 'x' : ' '}] ${r.data.text}`).join('\n'));
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `mind-bank-${dayKey(new Date())}.zip` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    if (missing) alert(`${missing} file(s) were not on this device and could not be downloaded. Export again when online.`);
  } catch (e) {
    alert('Export failed: ' + (e.message || e));
  } finally { btn.disabled = false; }
}

// ---------- events ----------
$('#task-form').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('#task-input').value.trim();
  if (!text) return;
  save({ id: crypto.randomUUID(), kind: 'task', deleted: false, data: { text, done: false, created_at: new Date().toISOString(), tags: tagsOf(text) } });
  $('#task-input').value = '';
});
$('#rec').addEventListener('click', onRecClick);
$('#rec-pause').addEventListener('click', togglePause);
$('#rec-discard').addEventListener('click', discardAudio);

// entry date: defaults to the journal day (before 4 am counts as yesterday); you can pick any past date
function setEntryDay() {
  const el = $('#entry-day');
  el.max = dayKey(new Date());
  if (!ui.entryDayPicked) el.value = journalDay();
  $('#entry-day-name').textContent = el.value ? fmtDay(el.value) : '';
}
$('#entry-day').addEventListener('change', e => {
  if (!e.target.value) { ui.entryDayPicked = false; return setEntryDay(); }
  if (e.target.value > dayKey(new Date())) { flash('Pick today or an earlier date.'); ui.entryDayPicked = false; return setEntryDay(); }
  ui.entryDayPicked = true;
  setEntryDay();
});
// move an already-banked entry to another date
document.addEventListener('change', e => {
  const t = e.target.closest('input[data-move]');
  if (!t) return;
  const r = rows.get(t.dataset.move);
  if (!r || !t.value || t.value > dayKey(new Date())) { t.value = r ? entryDay(r) : ''; return flash('Pick today or an earlier date.'); }
  save({ ...r, data: { ...r.data, day: t.value } });
  flash(`Moved to ${fmtDay(t.value)}.`);
});
$('#add-photo').addEventListener('click', () => $('#photo-input').click());
$('#photo-input').addEventListener('change', async e => {
  for (const f of e.target.files) { const blob = await shrink(f); draft.photos.push({ blob, url: URL.createObjectURL(blob) }); }
  e.target.value = '';
  renderDraftPhotos();
});
$('#moods').innerHTML = MOODS.map(m => `<label><input type="radio" name="mood" value="${m}"><span>${m}</span></label>`).join('');
// tapping the chosen mood again clears it
$('#moods').addEventListener('click', e => {
  const r = e.target.closest('input');
  if (!r) return;
  if (draft.mood === r.value) { r.checked = false; draft.mood = null; } else draft.mood = r.value;
});
$('#bank').addEventListener('click', bankIt);
$('#new-prompt').addEventListener('click', () => {
  let p; do p = PROMPTS[Math.floor(Math.random() * PROMPTS.length)]; while (p === ui.prompt);
  $('#prompt').textContent = ui.prompt = p;
});
$('#q').addEventListener('input', e => { ui.q = e.target.value.trim(); ui.limit = 30; render(); });
$('#day').addEventListener('change', e => { ui.day = e.target.value || null; ui.limit = 30; render(); });
$('#day-prev').addEventListener('click', () => { ui.day = shiftDay(ui.day || journalDay(), ui.day ? -1 : 0); render(); });
$('#day-next').addEventListener('click', () => { ui.day = shiftDay(ui.day || journalDay(), ui.day ? 1 : 0); render(); });
$('#day-all').addEventListener('click', () => { ui.day = null; render(); });
$('#more').addEventListener('click', () => { ui.limit += 30; render(); });
$('#export').addEventListener('click', exportAll);
$('#entry-text').addEventListener('input', e => { try { localStorage.setItem('mb-draft', e.target.value); } catch { /* storage blocked */ } });

document.addEventListener('click', e => {
  const t = e.target.closest('button, input[data-toggle]');
  if (!t) return;
  if (t.dataset.toggle) {
    const r = rows.get(t.dataset.toggle);
    return save({ ...r, data: { ...r.data, done: t.checked, done_at: t.checked ? new Date().toISOString() : null } });
  }
  if (t.dataset.tag) {
    const tag = '#' + t.dataset.tag;
    ui.q = ui.q.split(/\s+/).includes(tag) ? ui.q.split(/\s+/).filter(w => w !== tag).join(' ') : tag;
    $('#q').value = ui.q;
    ui.limit = 30;
    return render();
  }
  if (t.dataset.day) { ui.day = ui.day === t.dataset.day ? null : t.dataset.day; return render(); }
  if (t.dataset.play) return togglePlay(t.dataset.play);
  if (t.dataset.unphoto) {
    const [p] = draft.photos.splice(+t.dataset.unphoto, 1);
    URL.revokeObjectURL(p.url);
    return renderDraftPhotos();
  }
  const delId = t.dataset.delTask || t.dataset.delEntry;
  if (delId) {
    // two taps to delete: first arms the button, second deletes
    if (!t.dataset.armed) {
      t.dataset.armed = '1';
      t.innerHTML = 'delete?';
      return setTimeout(() => { if (t.isConnected) { delete t.dataset.armed; t.innerHTML = ICON.x; } }, 3000);
    }
    const r = rows.get(delId);
    if (r.kind === 'entry') for (const p of mediaPaths(r.data)) { idb.del('media', p); urls.delete(p); }
    return save({ ...r, deleted: true });
  }
});

window.addEventListener('online', sync);
window.addEventListener('offline', idleStatus);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    sync();
    setEntryDay();
    if (recording()) keepAwake(); // the screen lock is released while the app is in the background
  } else if (recording() && matchMedia('(pointer: coarse)').matches) {
    // phones pause the microphone in the background; stop cleanly so nothing said so far is lost
    rec.stopNote = 'Recording stopped when you left the app. Everything up to that point is kept.';
    stopRec();
  }
});
setInterval(() => document.visibilityState === 'visible' && sync(), 60000);

// ---------- boot ----------
$('#lock').hidden = !SUPABASE_URL; // stay covered until the session check says who this is
$('#prompt').textContent = ui.prompt;
try { $('#entry-text').value = localStorage.getItem('mb-draft') || ''; } catch { /* storage blocked */ }
navigator.storage?.persist?.();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
for (const r of await idb.all('items')) rows.set(r.id, r);
setEntryDay();
try { const a = await idb.get('meta', 'draftAudio'); if (a?.blob) setDraftAudio(a), setRecButton(false); } catch { /* nothing saved */ }
render();
initRemote();
