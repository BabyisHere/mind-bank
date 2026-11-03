// Pure functions: no DOM, so `node test.mjs` can check them.

export const MOODS = ['calm', 'driven', 'tired', 'grateful', 'restless', 'low'];

export const tagsOf = text =>
  [...new Set((text.match(/#[\p{L}\p{N}_-]+/gu) || []).map(t => t.slice(1).toLowerCase()))];

export const dayKey = d => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

export const shiftDay = (key, n) => {
  const [y, m, d] = key.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + n));
};

// The journal day: before this hour, you are still writing about yesterday.
export const DAY_STARTS_AT = 4;
export const journalDay = (now = new Date()) => {
  const x = new Date(now);
  return x.getHours() < DAY_STARTS_AT ? shiftDay(dayKey(x), -1) : dayKey(x);
};

// The day an entry belongs to: the date you chose when banking, else the day it was saved.
export const entryDay = r => r.data.day || dayKey(r.data.created_at);

// Consecutive days with an entry. Today without an entry yet does not break it.
export function streak(entries, now = new Date()) {
  const days = new Set(entries.map(entryDay));
  let k = journalDay(now);
  if (!days.has(k)) k = shiftDay(k, -1);
  let n = 0;
  while (days.has(k)) { n++; k = shiftDay(k, -1); }
  return n;
}

// Monday-to-Sunday day keys for the week containing `now`.
export function weekDays(now = new Date()) {
  const today = journalDay(now);
  const [y, m, d] = today.split('-').map(Number);
  const monday = shiftDay(today, -((new Date(y, m - 1, d).getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => shiftDay(monday, i));
}

// Every word of the query must hit: "#tag" matches tags, anything else matches text, transcript, mood, tags.
export function matches(row, q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const d = row.data;
  const tags = d.tags || [];
  const hay = [d.text, d.transcript, d.mood, d.prompt, ...tags].filter(Boolean).join(' ').toLowerCase();
  return words.every(w => w.startsWith('#') ? tags.includes(w.slice(1)) : hay.includes(w));
}

// Average a level trace down to n bars scaled 0..1.
export function peaks(levels, n = 48) {
  if (!levels.length) return Array(n).fill(0);
  const out = Array.from({ length: n }, (_, i) => {
    const a = Math.floor(i * levels.length / n), b = Math.max(a + 1, Math.floor((i + 1) * levels.length / n));
    const s = levels.slice(a, b);
    return s.reduce((x, y) => x + y, 0) / s.length;
  });
  const max = Math.max(...out) || 1;
  return out.map(v => +(v / max).toFixed(2));
}

// Last write wins, by the time the edit was made on its device.
export const takeRemote = (local, remote) =>
  !local || Date.parse(remote.updated_at) >= Date.parse(local.updated_at);

export const mediaPaths = d => [...(d.audio ? [d.audio.path] : []), ...(d.photos || [])];

export const fmtDuration = s => {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  return h ? `${h}h ${m}m` : `${m}:${String(sec).padStart(2, '0')}`;
};
