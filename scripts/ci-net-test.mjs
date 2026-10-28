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
const clock = { id: 'clock', cmd: `date -s @${epoch} >/dev/null; echo T1-$((6*7))`, done: /T1-42/, pass: /T1-42/, secs: 120 };
const lat = (n) => ({ id: `latency ${n} (trivial echo)`, cmd: `echo LAT${n}-$((6*7))`, done: new RegExp(`LAT${n}-42`), pass: new RegExp(`LAT${n}-42`), secs: 120, poll: 500 });
const bench = [
  { id: 'cpu benchmark (100000-iteration shell loop)', cmd: 'time ( i=0; while [ $i -lt 100000 ]; do i=$((i+1)); done ); echo B1-$((6*7))', done: /B1-42/, pass: /real/, secs: 900 },
  { id: 'pacman -Si nano (database load)', cmd: 'time pacman -Si nano > /dev/null; echo B2-$((6*7))', done: /B2-42/, pass: /real/, secs: 1500 },
];
const dhcp = { id: 'dhcp', cmd: 'systemctl restart systemd-networkd; sleep 5; ip -4 -br addr show; echo T3-$((6*7))', done: /T3-42/, pass: /192\.168\.127\.\d+/, secs: 600 };
const relay = [
  clock, lat(1), lat(2), lat(3), ...bench, dhcp,
  { id: 'dns', cmd: 'getent hosts geo.mirror.pkgbuild.com; echo T4-$((6*7))', done: /T4-42/, pass: /\d+\.\d+\.\d+\.\d+\s+\S*pkgbuild/, secs: 300 },
  { id: 'arch-mirror', cmd: 'curl -sS -m 120 -o /dev/null -w "MIRROR-%{http_code}-X\\n" https://geo.mirror.pkgbuild.com/core/os/x86_64/core.db; echo T5-$((6*7))', done: /T5-42/, pass: /MIRROR-200-X/, secs: 400 },
  { id: 'pacman -Sy', cmd: 'pacman -Sy --noconfirm; echo T6-$?-$((6*7))', done: /T6-\d+-42/, pass: /T6-0-42/, secs: 1200 },
  // the install runs in the background; we poll its log so a slow run shows what it is doing
  { id: 'pacman -S nano (background, polled)', cmd: '( pacman -S --noconfirm --needed nano > /tmp/p.log 2>&1; echo $? > /tmp/p.rc ) &', done: /\[1\]\s+\d+/, pass: /\[1\]\s+\d+/, secs: 60 },
  { id: 'install progress', poll_cmd: 'echo P-$(date +%s)-$(cat /tmp/p.rc 2>/dev/null || echo running)-X; tail -c 250 /tmp/p.log | tr "\\r" "\\n" | tail -3; cat /proc/loadavg', until: /P-\d+-(\d+)-X/, passIf: /P-\d+-0-X/, every: 60, secs: 1800 },
  { id: 'run nano', cmd: 'nano --version | head -1; echo T8-$((6*7))', done: /T8-42/, pass: /GNU nano/, secs: 300 },
];
const browser = [
  clock, lat(1), lat(2), lat(3),
  { id: 'mount shared folder', cmd: 'mount -t 9p -o trans=virtio,version=9p2000.L wasm0 /mnt; echo T2-$?-$((6*7)); ls /mnt', done: /T2-\d+-42/, pass: /T2-0-42/, secs: 900 },
  dhcp,
  { id: 'npm registry via proxy', cmd: `export SSL_CERT_FILE=/mnt/proxy.crt http_proxy=${PROXY} https_proxy=${PROXY} HTTP_PROXY=${PROXY} HTTPS_PROXY=${PROXY}; curl -sS -m 120 -o /dev/null -w "NPM-%{http_code}-X\\n" https://registry.npmjs.org/left-pad; echo T4-$((6*7))`, done: /T4-42/, pass: /NPM-200-X/, secs: 400 },
  { id: 'github raw via proxy', cmd: 'curl -sS -m 120 https://raw.githubusercontent.com/madler/zlib/master/README | head -3; echo T5-$((6*7))', done: /T5-42/, pass: /zlib/i, secs: 400 },
  { id: 'arch mirror via proxy (expected to FAIL: no CORS)', cmd: 'curl -sS -m 120 -o /dev/null -w "MIRROR-%{http_code}-X\\n" https://geo.mirror.pkgbuild.com/core/os/x86_64/core.db; echo T6-$((6*7))', done: /T6-42/, pass: /MIRROR-200-X/, secs: 400 },
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
    let ok = false, finished = false;
    if (s.poll_cmd) {                      // poll a background job
      while ((Date.now() - t1) < s.secs * 1000) {
        await type(s.poll_cmd + '\r');
        const t2 = Date.now();
        while ((Date.now() - t2) < 120000) {
          text = await screen();
          const ms = [...text.matchAll(/P-\d+-(\w+)-X\n/g)];
          if (ms.length && ms[ms.length - 1][1] !== 'running') { finished = true; ok = /^0$/.test(ms[ms.length - 1][1]); break; }
          if (ms.length && (Date.now() - t2) > 20000) break;
          await sleep(1000);
        }
        console.log(`[${sec()}s] progress: ` + text.split('\n').filter(l => l.trim()).slice(-5).join(' | ').slice(0, 400));
        if (finished) break;
        await sleep((s.every || 60) * 1000);
      }
    } else {
      await type(s.cmd + '\r');
      while ((Date.now() - t1) < s.secs * 1000) {
        text = await screen();
        if (s.done.test(text)) { finished = true; ok = s.pass.test(text); break; }
        await sleep(s.poll || 2000);
      }
      if (!finished) { await type('\x03'); await sleep(1500); await type('\x03'); await sleep(5000); }   // unblock the shell for the next step
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
