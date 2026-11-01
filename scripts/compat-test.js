'use strict';
// Google sign-in compatibility test. Start the browser with IZI_COMPAT_EXTRA_HOSTS=127.0.0.1
// so the local test server is treated like accounts.google.com, then run: npm run test:compat
const http = require('http');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = (req) => `<!doctype html><title>ua</title><body><pre id=h>${JSON.stringify({ ua: req.headers['user-agent'], ch: req.headers['sec-ch-ua'] || null })}</pre>
<button id=open onclick="window.open('http://127.0.0.1:'+location.port+'/popup','pop','width=400,height=500')">open</button><p id=msg></p>
<script>addEventListener('message', (e) => { document.getElementById('msg').textContent = 'got:' + e.data; });</script></body>`;
const popup = `<!doctype html><title>popup</title><script>window.opener && window.opener.postMessage('from-popup:' + navigator.userAgent.includes('Firefox'), '*'); setTimeout(() => close(), 300);</script>`;
(async () => {
  const srv = http.createServer((req, res) => res.end(req.url.startsWith('/popup') ? popup : page(req))).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const port = srv.address().port;
  const c = new Client({ name: 'compat-test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:9420/mcp')));
  const call = async (name, args = {}) => { const r = await c.callTool({ name, arguments: args }); if (r.isError) throw new Error(r.content[0].text); return r.content[0].text; };
  const probe = `({ header: JSON.parse(document.getElementById('h').textContent), js: { ua: navigator.userAgent, uaData: 'userAgentData' in navigator, vendor: navigator.vendor, chrome: typeof window.chrome, platform: navigator.platform } })`;
  let fail = 0;
  const check = (label, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) fail++; };

  await call('open_tab', { url: `http://127.0.0.1:${port}/` }); await sleep(1500);
  const a = JSON.parse(await call('evaluate', { expression: probe }));
  console.log('compat host  :', JSON.stringify(a));
  check('header UA is Firefox on compat host', /Firefox\/\d+/.test(a.header.ua) && !/Chrome/.test(a.header.ua));
  check('no sec-ch-ua client hints on compat host', a.header.ch === null);
  check('navigator.userAgent is Firefox', /Firefox\/\d+/.test(a.js.ua));
  check('navigator.userAgentData removed', a.js.uaData === false);
  check('navigator.vendor empty', a.js.vendor === '');

  await call('navigate', { url: `http://localhost:${port}/` });
  const b = JSON.parse(await call('evaluate', { expression: probe }));
  console.log('normal host  :', JSON.stringify(b));
  check('header UA back to Chrome elsewhere', /Chrome\/\d+/.test(b.header.ua) && !/Electron|Firefox/.test(b.header.ua));
  check('navigator.userAgent back to Chrome', /Chrome\/\d+/.test(b.js.ua) && !/Firefox/.test(b.js.ua));
  check('userAgentData back elsewhere', b.js.uaData === true);

  await call('click', { selector: '#open' });
  await sleep(2500);
  const raw = await call('evaluate', { expression: `document.getElementById('msg').textContent` }); let m; try { m = JSON.parse(raw); } catch { m = raw; }
  console.log('popup msg    :', m);
  check('popup keeps window.opener (postMessage reached opener)', String(m).startsWith('got:from-popup')); check('popup on sign-in host sees Firefox', String(m) === 'got:from-popup:true');

  await c.close(); srv.close();
  console.log(fail ? `\n${fail} check(s) failed` : '\nAll compat checks passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
