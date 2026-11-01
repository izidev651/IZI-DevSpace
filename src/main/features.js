'use strict';
// Page-level features: device presets, full-page capture, fake fill, element snapshot.

const DEVICES = {
  'iphone-15-pro': { name: 'iPhone 15 Pro', width: 393, height: 852, dpr: 3, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
  'iphone-se': { name: 'iPhone SE', width: 375, height: 667, dpr: 2, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
  'pixel-8': { name: 'Pixel 8', width: 412, height: 915, dpr: 2.625, ua: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36' },
  'galaxy-s24': { name: 'Galaxy S24', width: 360, height: 780, dpr: 3, ua: 'Mozilla/5.0 (Linux; Android 15; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36' },
  'ipad-mini': { name: 'iPad Mini', width: 768, height: 1024, dpr: 2, ua: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
};

const SEARCH_ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  brave: { name: 'Brave', url: 'https://search.brave.com/search?q=%s' },
};

function resolveInput(input, engine = 'google') {
  const text = String(input || '').trim();
  if (!text) return null;
  if (/^(https?|file|izi|about|data|chrome|view-source):/i.test(text)) return text;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(text) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(text)) return 'http://' + text;
  if (!/\s/.test(text) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(text)) return 'https://' + text;
  const e = SEARCH_ENGINES[engine] || SEARCH_ENGINES.google;
  return e.url.replace('%s', encodeURIComponent(text));
}

// ---------- CDP helper ----------
async function cdp(wc, method, params = {}) {
  const dbg = wc.debugger;
  if (!dbg.isAttached()) {
    try { dbg.attach('1.3'); } catch (err) { throw new Error('Cannot attach debugger: ' + err.message); }
  }
  return dbg.sendCommand(method, params);
}

async function captureFullPage(wc) {
  const metrics = await cdp(wc, 'Page.getLayoutMetrics');
  const size = metrics.cssContentSize || metrics.contentSize;
  const width = Math.max(1, Math.ceil(size.width));
  const height = Math.max(1, Math.min(Math.ceil(size.height), 30000));
  const shot = await cdp(wc, 'Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    fromSurface: true,
    clip: { x: 0, y: 0, width, height, scale: 1 },
  });
  return { buffer: Buffer.from(shot.data, 'base64'), width, height };
}

// ---------- Fake Fill (runs inside the page) ----------
const FAKE_FILL_SCRIPT = `(() => {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const firsts = ['Andi','Budi','Citra','Dewi','Eka','Fajar','Gita','Hendra','Intan','Joko','Sarah','Michael','Emma','Liam'];
  const lasts = ['Pratama','Wijaya','Saputra','Lestari','Santoso','Hidayat','Kusuma','Nugroho','Smith','Johnson'];
  const cities = ['Jakarta','Bandung','Surabaya','Yogyakarta','Medan','Denpasar','Semarang','Makassar'];
  const streets = ['Jl. Sudirman','Jl. Thamrin','Jl. Gatot Subroto','Jl. Diponegoro','Jl. Merdeka','Jl. Asia Afrika'];
  const companies = ['PT Maju Jaya','CV Sinar Abadi','PT Nusantara Digital','Acme Corp','Globex Ltd'];
  const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore'.split(' ');
  const rnd = (n) => Array.from({length:n}, () => Math.floor(Math.random()*10)).join('');
  const first = pick(firsts), last = pick(lasts), city = pick(cities);
  const user = (first + '.' + last).toLowerCase() + rnd(2);
  const person = {
    first, last, full: first + ' ' + last, user,
    email: user + '@example.com', phone: '+62 8' + rnd(2) + '-' + rnd(4) + '-' + rnd(4),
    company: pick(companies), city, zip: rnd(5), street: pick(streets) + ' No. ' + (1 + Math.floor(Math.random()*200)),
    password: 'Test@' + rnd(6) + 'Aa', url: 'https://example.com/' + user,
  };
  const sentence = (n) => { const s = Array.from({length:n}, () => pick(words)).join(' '); return s[0].toUpperCase() + s.slice(1) + '.'; };
  const fmtDate = (d) => d.toISOString().slice(0,10);

  function labelOf(el) {
    let t = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.autocomplete, el.className].join(' ');
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) t += ' ' + l.textContent; }
    const pl = el.closest('label'); if (pl) t += ' ' + pl.textContent;
    return t.toLowerCase();
  }

  function valueFor(el) {
    const type = (el.type || 'text').toLowerCase();
    const l = labelOf(el);
    const has = (...k) => k.some((x) => l.includes(x));
    if (type === 'email' || has('email','e-mail','surel')) return person.email;
    if (type === 'password' || has('password','sandi')) return person.password;
    if (type === 'tel' || has('phone','tel','mobile','hp','telepon','whatsapp')) return person.phone;
    if (type === 'url' || has('website','url','homepage')) return person.url;
    if (type === 'date') return fmtDate(new Date(Date.now() - (20 + Math.random()*20) * 365 * 864e5));
    if (type === 'datetime-local') return new Date().toISOString().slice(0,16);
    if (type === 'time') return '09:30';
    if (type === 'month') return new Date().toISOString().slice(0,7);
    if (type === 'week') return new Date().getFullYear() + '-W10';
    if (type === 'color') return '#1fc7b6';
    if (type === 'number' || type === 'range') {
      const min = el.min !== '' ? Number(el.min) : 1, max = el.max !== '' ? Number(el.max) : Math.max(min + 99, 100);
      return String(Math.floor(min + Math.random() * (max - min + 1)));
    }
    if (has('card','cc-number','kartu')) return '4242 4242 4242 4242';
    if (has('cvc','cvv','csc')) return '123';
    if (has('exp')) return '12/30';
    if (has('first','given','depan','fname')) return person.first;
    if (has('last','family','surname','belakang','lname')) return person.last;
    if (has('user','login','nick')) return person.user;
    if (has('full name','fullname','nama lengkap') || /\\bname\\b|nama/.test(l)) return person.full;
    if (has('company','organization','organisation','perusahaan')) return person.company;
    if (has('address','street','alamat','addr')) return person.street;
    if (has('city','kota','town')) return person.city;
    if (has('zip','postal','postcode','kode pos')) return person.zip;
    if (has('country','negara')) return 'Indonesia';
    if (has('state','province','provinsi')) return 'DKI Jakarta';
    if (has('age','umur','usia')) return String(20 + Math.floor(Math.random()*30));
    if (has('search','cari','query')) return '';
    if (el.tagName === 'TEXTAREA') return sentence(18);
    return sentence(3).slice(0, -1);
  }

  function setNative(el, v) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter ? setter.call(el, v) : (el.value = v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  let count = 0;
  const radiosDone = new Set();
  const els = Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"]'));
  for (const el of els) {
    if (el.disabled || el.readOnly) continue;
    const type = (el.type || '').toLowerCase();
    if (['hidden','submit','button','reset','image','file'].includes(type)) continue;
    if (!visible(el) && type !== 'checkbox' && type !== 'radio') continue;
    try {
      if (el.isContentEditable && !('value' in el)) { el.textContent = sentence(10); el.dispatchEvent(new Event('input', {bubbles:true})); count++; continue; }
      if (el.tagName === 'SELECT') {
        const opts = Array.from(el.options).filter((o) => !o.disabled && o.value !== '');
        if (opts.length) { setNative(el, pick(opts).value); count++; }
        continue;
      }
      if (type === 'checkbox') { if (!el.checked && (el.required || Math.random() > 0.4)) { el.click(); count++; } continue; }
      if (type === 'radio') {
        if (!el.name || radiosDone.has(el.name)) continue;
        radiosDone.add(el.name);
        const group = els.filter((x) => x.type === 'radio' && x.name === el.name && !x.disabled);
        const choice = pick(group); if (choice && !choice.checked) choice.click(); count++;
        continue;
      }
      const v = valueFor(el);
      if (v === '') continue;
      const max = el.maxLength > 0 ? el.maxLength : 0;
      setNative(el, max ? v.slice(0, max) : v);
      count++;
    } catch (e) {}
  }
  return count;
})()`;

async function fakeFill(wc) {
  let total = 0;
  const frames = wc.mainFrame ? wc.mainFrame.framesInSubtree : [];
  if (!frames.length) return wc.executeJavaScript(FAKE_FILL_SCRIPT, true);
  for (const f of frames) {
    try { total += (await f.executeJavaScript(FAKE_FILL_SCRIPT, true)) || 0; } catch {}
  }
  return total;
}

// ---------- Interactive snapshot (used by MCP) ----------
const SNAPSHOT_SCRIPT = `(() => {
  const sel = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="option"], [contenteditable="true"], [onclick], [tabindex]:not([tabindex="-1"])';
  document.querySelectorAll('[data-tide-ref]').forEach((e) => e.removeAttribute('data-tide-ref'));
  const out = [];
  let i = 1;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || cs.visibility === 'hidden' || cs.display === 'none' || el.disabled) continue;
    el.setAttribute('data-tide-ref', String(i));
    const role = el.getAttribute('role') || el.tagName.toLowerCase() + (el.type ? '[' + el.type + ']' : '');
    let name = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.alt || el.name || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    const extra = el.tagName === 'A' ? ' -> ' + el.getAttribute('href').slice(0, 100) : '';
    const inView = r.bottom > 0 && r.top < innerHeight ? '' : ' (offscreen)';
    out.push('[' + i + '] ' + role + ' "' + name + '"' + extra + inView);
    i++;
    if (i > 400) break;
  }
  return { url: location.href, title: document.title, elements: out };
})()`;

function elementCenterScript(target) {
  const q = target.ref != null ? `[data-tide-ref="${Number(target.ref)}"]` : String(target.selector || '');
  return `(() => {
    const el = document.querySelector(${JSON.stringify(q)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: el.tagName };
  })()`;
}

function focusScript(target, clear) {
  const q = target.ref != null ? `[data-tide-ref="${Number(target.ref)}"]` : String(target.selector || '');
  return `(() => {
    const el = document.querySelector(${JSON.stringify(q)});
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    if (${clear ? 'true' : 'false'}) {
      if ('value' in el) { el.select?.(); } else if (el.isContentEditable) { document.execCommand('selectAll'); }
    }
    return true;
  })()`;
}

module.exports = { DEVICES, SEARCH_ENGINES, resolveInput, cdp, captureFullPage, fakeFill, SNAPSHOT_SCRIPT, elementCenterScript, focusScript };
