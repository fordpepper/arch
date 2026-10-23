// Serves ./site with COOP/COEP, opens it in headless Chromium, and times the Arch boot.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const root = path.resolve(process.argv[2] || 'site');
const limitMin = Number(process.env.BOOT_TIMEOUT_MIN || 40);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.data': 'application/octet-stream' };

const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  const size = fs.statSync(p).size;
  res.writeHead(200, {
    'content-type': types[path.extname(p)] || 'application/octet-stream',
    'content-length': size,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(8088, '127.0.0.1', r));

const browser = await chromium.launch({ args: ['--enable-features=SharedArrayBuffer'] });
const page = await browser.newPage();
const t0 = Date.now();
const sec = () => ((Date.now() - t0) / 1000).toFixed(1);
const marks = {};
page.on('pageerror', e => console.log(`[${sec()}s] PAGEERROR ${e.message}`));
page.on('console', m => { const t = m.text(); if (/error|abort|out of memory|RuntimeError/i.test(t)) console.log(`[${sec()}s] console: ${t.slice(0, 300)}`); });
await page.goto('http://127.0.0.1:8088/index.html');

const screen = () => page.evaluate(() => {
  if (!window.term) return '';
  const b = window.term.buffer.active, out = [];
  for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) out.push(l.translateToString(true)); }
  return out.join('\n');
});
const SNAP = process.env.MODE === 'snapshot';
const checks = SNAP ? [['snapshot_command_answered', /SNAP-OK-42/]] : [
  ['first_output', /\S/],
  ['kernel_started', /Linux version|Booting|Decompressing/i],
  ['systemd_started', /systemd\[1\]|Welcome to|Starting|Reached target/i],
  ['login_prompt_or_shell', /\[root@[^\]]+\]#|archlinux login:/],
];
let text = '';
let lastLog = 0;
while ((Date.now() - t0) / 60000 < limitMin) {
  text = await screen();
  for (const [name, re] of checks) if (!marks[name] && re.test(text)) { marks[name] = sec(); console.log(`[${sec()}s] MARK ${name}`); }
  if (SNAP && !marks.snapshot_command_answered && Date.now() - (globalThis.__lastNudge || 0) > 15000) {
    globalThis.__lastNudge = Date.now();
    await page.evaluate(() => window.term && window.term.paste('\recho SNAP-OK-$((6*7))\r'));
  }
  if (marks.login_prompt_or_shell || marks.snapshot_command_answered) break;
  if (Date.now() - lastLog > 60000) { lastLog = Date.now(); console.log(`[${sec()}s] still booting; last line: ${text.trim().split('\n').pop().slice(0, 120)}`); }
  await new Promise(r => setTimeout(r, 2000));
}
console.log('--- SCREEN (last 40 lines) ---');
console.log(text.split('\n').slice(-40).join('\n'));
console.log('--- RESULT ---');
console.log(JSON.stringify({ marks, booted: !!(marks.login_prompt_or_shell || marks.snapshot_command_answered), total_seconds: sec() }));
await browser.close(); server.close();
process.exit((marks.login_prompt_or_shell || marks.snapshot_command_answered) ? 0 : 1);
