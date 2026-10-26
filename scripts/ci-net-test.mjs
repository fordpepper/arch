// Usage: node ci-net-test.mjs <siteDir> <relay|browser>
// Resumes the snapshot in headless Chromium, then types commands into the guest and checks the results.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const root = path.resolve(process.argv[2] || 'site');
const mode = process.argv[3] || 'relay';
const query = mode === 'relay' ? '?net=delegate=ws://localhost:9999' : '?net=browser';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.gzip': 'application/gzip' };

const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index-net.html'));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, {
    'content-type': types[path.extname(p)] || 'application/octet-stream',
    'content-length': fs.statSync(p).size,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(8088, '127.0.0.1', r));

const epoch = Math.floor(Date.now() / 1000);
const PROXY = 'http://192.168.127.253:80';
const common = [
  { id: 'clock', cmd: `date -s @${epoch} >/dev/null; echo T1-$((6*7))`, done: /T1-42/, pass: /T1-42/, secs: 60 },
];
const dhcp = { id: 'dhcp', cmd: 'systemctl restart systemd-networkd; sleep 10; ip -4 -br addr show; echo T3-$((6*7))', done: /T3-42/, pass: /192\.168\.127\.\d+/, secs: 180 };
const relay = [
  ...common, dhcp,
  { id: 'dns', cmd: 'getent hosts geo.mirror.pkgbuild.com; echo T4-$((6*7))', done: /T4-42/, pass: /\d+\.\d+\.\d+\.\d+\s+\S*pkgbuild/, secs: 120 },
  { id: 'arch-mirror', cmd: 'curl -sS -m 120 -o /dev/null -w "MIRROR-%{http_code}-X\\n" https://geo.mirror.pkgbuild.com/core/os/x86_64/core.db; echo T5-$((6*7))', done: /T5-42/, pass: /MIRROR-200-X/, secs: 200 },
  { id: 'pacman -Sy', cmd: 'pacman -Sy --noconfirm; echo T6-$?-$((6*7))', done: /T6-\d+-42/, pass: /T6-0-42/, secs: 900 },
  { id: 'pacman -S nano', cmd: 'pacman -S --noconfirm --needed nano; echo T7-$?-$((6*7))', done: /T7-\d+-42/, pass: /T7-0-42/, secs: 1500 },
  { id: 'run nano', cmd: 'nano --version | head -1; echo T8-$((6*7))', done: /T8-42/, pass: /GNU nano/, secs: 90 },
];
const browser = [
  ...common,
  { id: 'trust proxy CA', cmd: 'mount -t 9p -o trans=virtio,version=9p2000.L wasm0 /mnt && trust anchor --store /mnt/proxy.crt && update-ca-trust; echo T2-$?-$((6*7))', done: /T2-\d+-42/, pass: /T2-0-42/, secs: 240 },
  dhcp,
  { id: 'npm registry via proxy', cmd: `export http_proxy=${PROXY} https_proxy=${PROXY} HTTP_PROXY=${PROXY} HTTPS_PROXY=${PROXY}; curl -sS -m 90 -o /dev/null -w "NPM-%{http_code}-X\\n" https://registry.npmjs.org/left-pad; echo T4-$((6*7))`, done: /T4-42/, pass: /NPM-200-X/, secs: 200 },
  { id: 'github raw via proxy', cmd: 'curl -sS -m 90 https://raw.githubusercontent.com/madler/zlib/master/README | head -3; echo T5-$((6*7))', done: /T5-42/, pass: /zlib/i, secs: 200 },
  { id: 'arch mirror via proxy (expected to FAIL: no CORS)', cmd: 'curl -sS -m 90 -o /dev/null -w "MIRROR-%{http_code}-X\\n" https://geo.mirror.pkgbuild.com/core/os/x86_64/core.db; echo T6-$((6*7))', done: /T6-42/, pass: /MIRROR-200-X/, secs: 200 },
];
const steps = mode === 'relay' ? relay : browser;

const browserApp = await chromium.launch({ args: ['--enable-features=SharedArrayBuffer'] });
const page = await browserApp.newPage();
const t0 = Date.now();
const sec = () => ((Date.now() - t0) / 1000).toFixed(1);
page.on('pageerror', e => console.log(`[${sec()}s] PAGEERROR ${e.message.slice(0, 300)}`));
page.on('console', m => { const t = m.text(); if (/error|abort|out of memory|RuntimeError|fail/i.test(t)) console.log(`[${sec()}s] console: ${t.slice(0, 300)}`); });
await page.goto(`http://127.0.0.1:8088/index-net.html${query}`);

const screen = () => page.evaluate(() => {
  if (!window.term) return '';
  const b = window.term.buffer.active, out = [];
  for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) out.push(l.translateToString(true)); }
  return out.join('\n');
});
const type = (text) => page.evaluate((t) => { const x = window.term; if (x && x.input) x.input(t, true); else if (x) x.paste(t); }, text);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log(`MODE ${mode}`);
let resumed = false, lastNudge = 0, text = '';
while ((Date.now() - t0) < 25 * 60000) {
  text = await screen();
  if (/READY-42/.test(text)) { resumed = true; console.log(`[${sec()}s] RESUMED (guest answered)`); break; }
  if (Date.now() - lastNudge > 15000) { lastNudge = Date.now(); await type('\recho READY-$((6*7))\r'); }
  await sleep(2000);
}
const results = [];
if (resumed) {
  for (const s of steps) {
    const t1 = Date.now();
    await type(s.cmd + '\r');
    let ok = false, finished = false;
    while ((Date.now() - t1) < s.secs * 1000) {
      text = await screen();
      if (s.done.test(text)) { finished = true; ok = s.pass.test(text); break; }
      await sleep(2000);
    }
    const tail = text.split('\n').filter(l => l.trim()).slice(-8).join('\n');
    results.push({ step: s.id, finished, pass: ok, seconds: Number(((Date.now() - t1) / 1000).toFixed(1)) });
    console.log(`[${sec()}s] STEP ${s.id}: ${ok ? 'PASS' : finished ? 'FAIL' : 'TIMEOUT'} in ${((Date.now() - t1) / 1000).toFixed(1)}s\n${tail}\n`);
  }
}
console.log('--- RESULT ---');
console.log(JSON.stringify({ mode, resumed, results }, null, 1));
await browserApp.close(); server.close();
process.exit(resumed && results.length && results.every(r => r.pass) ? 0 : 1);
