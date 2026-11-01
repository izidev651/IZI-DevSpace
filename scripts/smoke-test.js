'use strict';
// End-to-end smoke test: drives a running Tide Browser through its MCP server.
// Usage: start the browser, then `npm run test:smoke` (optionally MCP_URL=...).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const MCP_URL = process.env.MCP_URL || 'http://127.0.0.1:9420/mcp';
const OUT = process.env.SMOKE_OUT || path.join(process.cwd(), 'smoke-output');

const FORM = `<!doctype html><title>Signup form</title><body style="font-family:sans-serif;padding:20px">
<h1>Signup</h1><form id="f" onsubmit="event.preventDefault();document.getElementById('done').textContent='Submitted: '+new FormData(this).get('email')">
<label>Full name <input name="fullname"></label><br><label>Email <input type="email" name="email" id="email"></label><br>
<label>Phone <input type="tel" name="phone"></label><br><label>City <input name="city"></label><br>
<label>Password <input type="password" name="password"></label><br><select name="country"><option value="">-</option><option>ID</option><option>SG</option></select>
<textarea name="bio"></textarea><label><input type="checkbox" name="tos" required> agree</label>
<button id="go">Send</button></form><p id="done"></p>${'<p>filler line</p>'.repeat(120)}</body>`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(FORM); }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const pageUrl = `http://127.0.0.1:${srv.address().port}/form`;

  const client = new Client({ name: 'tide-smoke-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const txt = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (r.isError) throw new Error(`${name} failed: ${txt}`);
    console.log(`✔ ${name}`, txt ? txt.slice(0, 160).replace(/\s+/g, ' ') : `(${r.content.map((c) => c.type).join(',')})`);
    return { r, txt };
  };

  const { tools } = await client.listTools();
  console.log(`✔ tools/list → ${tools.length} tools`);
  await call('list_spaces');
  const { txt: opened } = await call('open_tab', { url: pageUrl });
  const tabId = JSON.parse(opened).id;
  await call('snapshot');
  const { txt: filled } = await call('fake_fill');
  if (!(JSON.parse(filled).filled > 3)) throw new Error('fake_fill filled too few fields');
  await call('type', { selector: '#email', text: 'smoke@test.dev' });
  await call('click', { selector: '#go' });
  const { txt: page } = await call('get_page_text', { maxChars: 400 });
  if (!page.includes('Submitted: smoke@test.dev')) throw new Error('form submit not detected');
  const { r: shot } = await call('screenshot');
  fs.writeFileSync(path.join(OUT, 'viewport.jpg'), Buffer.from(shot.content[0].data, 'base64'));
  const { txt: cap } = await call('capture_full_page');
  console.log('   saved', JSON.parse(cap).file);
  await call('mobile_view', { enabled: true, device: 'pixel-8' });
  await new Promise((r) => setTimeout(r, 1500));
  const { txt: ua } = await call('evaluate', { expression: '({ ua: navigator.userAgent, w: innerWidth, touch: navigator.maxTouchPoints })' });
  if (!ua.includes('Android')) throw new Error('mobile UA not applied');
  if (process.env.SMOKE_PAUSE) await new Promise((r) => setTimeout(r, Number(process.env.SMOKE_PAUSE)));
  await call('mobile_view', { enabled: false });
  const { txt: t2 } = await call('open_tab', { url: 'tide://newtab/', background: true });
  await call('dock_tab', { tabId: JSON.parse(t2).id });
  if (process.env.SMOKE_PAUSE) await new Promise((r) => setTimeout(r, Number(process.env.SMOKE_PAUSE)));
  await call('dock_tab', { undock: true });
  await call('sleep_tab', { tabId: JSON.parse(t2).id });
  const { txt: list } = await call('list_tabs');
  if (!JSON.parse(list).some((t) => t.id === JSON.parse(t2).id && t.sleeping)) throw new Error('tab did not sleep');
  await call('history', { action: 'reload', tabId });
  await call('close_tab', { tabId: JSON.parse(t2).id });

  await client.close();
  srv.close();
  console.log('\nAll smoke checks passed.');
}

main().catch((err) => { console.error('✘', err.message); process.exit(1); });
