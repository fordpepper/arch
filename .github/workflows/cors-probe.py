#!/usr/bin/env python3
"""Which sites can a page fetch() from another origin? A browser needs an Access-Control-Allow-Origin
header on the response AND on every redirect hop. This script follows redirects with curl and checks each hop."""
import subprocess, sys

ORIGIN = 'https://example.github.io'
GROUPS = {
 'Arch mirrors (core.db)': [
  'https://geo.mirror.pkgbuild.com/core/os/x86_64/core.db',
  'https://mirror.pkgbuild.com/core/os/x86_64/core.db',
  'https://mirror.rackspace.com/archlinux/core/os/x86_64/core.db',
  'https://mirrors.kernel.org/archlinux/core/os/x86_64/core.db',
  'https://mirror.leaseweb.net/archlinux/core/os/x86_64/core.db',
  'https://ftp.halifax.rwth-aachen.de/archlinux/core/os/x86_64/core.db',
  'https://mirrors.dotsrc.org/archlinux/core/os/x86_64/core.db',
  'https://archive.archlinux.org/repos/last/core/os/x86_64/core.db',
 ],
 'Other sites a user might want': [
  'https://raw.githubusercontent.com/madler/zlib/master/README',
  'https://github.com/madler/zlib/archive/refs/heads/master.tar.gz',
  'https://api.github.com/',
  'https://registry.npmjs.org/left-pad',
  'https://pypi.org/simple/pip/',
  'https://cdn.jsdelivr.net/npm/left-pad/package.json',
  'https://deb.debian.org/debian/dists/stable/Release',
  'https://archlinux.org/',
  'https://example.com/',
  'https://en.wikipedia.org/wiki/Linux',
 ],
}
if len(sys.argv) > 1: GROUPS = {'custom': sys.argv[1:]}

def probe(url):
    r = subprocess.run(['curl', '-sS', '-L', '-m', '40', '--max-redirs', '6', '-o', '/dev/null', '-D', '-',
                        '-H', f'Origin: {ORIGIN}', '-H', 'Range: bytes=0-0', url], capture_output=True, text=True)
    if r.returncode != 0: return ('ERR', f'curl failed: {r.stderr.strip()[:60]}', [])
    hops = []
    for block in r.stdout.replace('\r', '').strip().split('\n\n'):
        lines = block.split('\n')
        if not lines or not lines[0].startswith('HTTP'): continue
        status = lines[0].split()[1] if len(lines[0].split()) > 1 else '?'
        h = {}
        for l in lines[1:]:
            if ':' in l: k, v = l.split(':', 1); h[k.strip().lower()] = v.strip()
        hops.append((status, h.get('access-control-allow-origin'), h.get('accept-ranges')))
    if not hops: return ('ERR', 'no response', [])
    ok = all(a in ('*', ORIGIN) for _, a, _ in hops)
    return ('OK' if ok else 'NO', f'final HTTP {hops[-1][0]}, {len(hops)} hop(s), ranges: {hops[-1][2] or "-"}', hops)

print(f'Probing with Origin: {ORIGIN} (a stand-in for a GitHub Pages site)\n')
tot = {'OK': 0, 'NO': 0, 'ERR': 0}
for g, urls in GROUPS.items():
    print(f'## {g}')
    for u in urls:
        v, d, hops = probe(u); tot[v] += 1
        acao = ' -> '.join((a or 'none') for _, a, _ in hops)
        print(f'  [{v:3}] {u}\n        {d}; Access-Control-Allow-Origin per hop: {acao}')
    print()
print('SUMMARY', tot)
