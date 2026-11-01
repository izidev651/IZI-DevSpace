'use strict';
const api = window.tideNewTab;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const THEMES = {
  teal: { bg: '#04121a', layers: ['#061b25', '#082833', '#0a3640', '#0e454c', '#125659'] },
  ocean: { bg: '#050b1a', layers: ['#0a1730', '#0e2245', '#132f5c', '#1a3d74', '#22508f'] },
  sunset: { bg: '#140a1c', layers: ['#2a1033', '#45173f', '#6b2245', '#963346', '#c44d3f'] },
  forest: { bg: '#07120c', layers: ['#0c1f15', '#112c1d', '#173b26', '#1e4b30', '#275e3b'] },
  mono: { bg: '#0b0d10', layers: ['#14181d', '#1b2026', '#232930', '#2b333b', '#353e47'] },
};

// Deterministic smooth wave paths (Catmull-Rom -> cubic Bezier)
function rand(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }
function wavePath(baseY, amp, seed) {
  const r = rand(seed);
  const pts = [];
  for (let x = -240; x <= 1680; x += 240) pts.push([x, baseY + (r() * 2 - 1) * amp]);
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0]},${p2[1].toFixed(1)}`;
  }
  return d + ' L1680,960 L-240,960 Z';
}
const LAYERS = [[290, 42, 7], [390, 52, 23], [490, 58, 41], [590, 62, 59], [690, 58, 97]];

let settings = { wave: 'teal', animate: true, showShortcuts: false, shortcuts: [] };

function paintWaves() {
  const th = THEMES[settings.wave] || THEMES.teal;
  document.body.style.setProperty('--bg', th.bg);
  $('#waves').innerHTML = LAYERS.map(([y, a, s], i) =>
    `<g class="layer" style="--dur:${9 + i * 2.5}s;--amp:${4 + i}px"><path d="${wavePath(y, a, s)}" fill="${th.layers[i]}"/></g>`).join('');
  document.body.classList.toggle('animate', !!settings.animate);
}

function paintShortcuts() {
  const box = $('#shortcuts');
  box.hidden = !settings.showShortcuts;
  box.innerHTML = (settings.shortcuts || []).map((s) => {
    let host = '';
    try { host = new URL(s.url).hostname; } catch {}
    return `<a class="sc" href="${esc(s.url)}"><div class="ico"><img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64" alt=""></div><span>${esc(s.title)}</span></a>`;
  }).join('');
  $('#sc-list').innerHTML = (settings.shortcuts || []).map((s, i) => `<div class="sc-item"><span>${esc(s.title)} · ${esc(s.url)}</span><button data-del="${i}" title="Remove">✕</button></div>`).join('') || '<div style="color:#6b7886;font-size:12px">No shortcuts</div>';
}

function paintCustomize() {
  $('#themes').innerHTML = Object.entries(THEMES).map(([k, t]) =>
    `<button class="th ${k === settings.wave ? 'on' : ''}" data-theme="${k}" title="${k}" style="background:linear-gradient(180deg, ${t.bg}, ${t.layers[2]} 55%, ${t.layers[4]})"></button>`).join('');
  $('#c-animate').checked = !!settings.animate;
  $('#c-shortcuts').checked = !!settings.showShortcuts;
}

function apply(s) {
  settings = { ...settings, ...(s || {}) };
  paintWaves();
  paintShortcuts();
  paintCustomize();
}

async function save(patch) {
  apply(patch);
  if (api) apply(await api.setSettings(patch));
}

$('#search').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#q').value.trim();
  if (!v) return;
  if (api) api.navigate(v); else location.href = 'https://www.google.com/search?q=' + encodeURIComponent(v);
});
$('#customize-btn').addEventListener('click', () => { $('#customize').hidden = !$('#customize').hidden; });
$('#c-close').addEventListener('click', () => { $('#customize').hidden = true; });
$('#themes').addEventListener('click', (e) => { const b = e.target.closest('[data-theme]'); if (b) save({ wave: b.dataset.theme }); });
$('#c-animate').addEventListener('change', (e) => save({ animate: e.target.checked }));
$('#c-shortcuts').addEventListener('change', (e) => save({ showShortcuts: e.target.checked }));
$('#sc-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-del]');
  if (!b) return;
  const list = [...settings.shortcuts];
  list.splice(Number(b.dataset.del), 1);
  save({ shortcuts: list });
});
$('#sc-add').addEventListener('submit', (e) => {
  e.preventDefault();
  let url = $('#sc-url').value.trim();
  const title = $('#sc-title').value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  let t = title;
  if (!t) { try { t = new URL(url).hostname.replace(/^www\./, ''); } catch { t = url; } }
  save({ shortcuts: [...(settings.shortcuts || []), { title: t, url }], showShortcuts: true });
  $('#sc-url').value = ''; $('#sc-title').value = '';
});

apply();
if (api) {
  api.getSettings().then((s) => s && apply(s.newTab));
  api.onSettings((s) => apply(s.newTab));
}
