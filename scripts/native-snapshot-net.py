#!/usr/bin/env python3
"""Boot Arch with a NATIVE build of the same QEMU source, save the whole machine state,
then prove the state restores natively. The browser build is later asked to load the same file."""
import json, os, re, shutil, socket, subprocess, sys, threading, time, traceback

Q = os.path.abspath('native-build/qemu-system-x86_64')
BIOS = os.path.abspath('qemu-wasm/pc-bios')
KERNEL = os.path.abspath('out/vmlinuz')
INITRD = os.path.abspath('out/initramfs.img')
STATE = os.path.abspath('out/state.bin')
DISK = os.path.abspath('out/rootfs-snap.img')
REPORT = open('report/native-snapshot.log', 'w')

def log(*a):
    s = ' '.join(str(x) for x in a)
    print(s, flush=True); REPORT.write(s + '\n'); REPORT.flush()

WASMENV = '/tmp/wasmenv'
os.makedirs(WASMENV, exist_ok=True)

def machine_args(disk):
    # MUST stay identical (same options, same ORDER) to web/module-net.js, so both machines have the same devices.
    return [Q, '-nographic', '-m', '512M', '-accel', 'tcg,tb-size=500', '-L', BIOS,
            '-drive', f'if=virtio,format=raw,file={disk}',
            '-kernel', KERNEL, '-initrd', INITRD,
            '-append', 'console=ttyS0,115200n8 root=/dev/vda rw rootwait loglevel=4 init_on_free=1 virtio_net.napi_tx=false',
            '-virtfs', f'local,path={WASMENV},mount_tag=wasm0,security_model=none,id=wasm0',
            '-netdev', 'socket,id=vmnic,connect=127.0.0.1:8888', '-device', 'virtio-net-pci,netdev=vmnic,mac=02:00:00:00:00:01']

def start_dummy_peer():
    """The browser build connects the network card to a relay. Here a dummy peer just swallows the frames."""
    srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(('127.0.0.1', 8888)); srv.listen(8)
    def drain(c):
        try:
            while c.recv(65536): pass
        except OSError: pass
    def loop():
        while True:
            try: c, _ = srv.accept()
            except OSError: return
            threading.Thread(target=drain, args=(c,), daemon=True).start()
    threading.Thread(target=loop, daemon=True).start()

class VM:
    def __init__(self, args, sock):
        if os.path.exists(sock): os.remove(sock)
        self.sock = sock
        self.p = subprocess.Popen(args + ['-qmp', f'unix:{sock},server=on,wait=off'],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0)
        self.buf = b''; self.t0 = time.time()
        threading.Thread(target=self._rd, daemon=True).start()
    def _rd(self):
        while True:
            b = self.p.stdout.read(4096)
            if not b: return
            self.buf += b
    def text(self): return self.buf.decode('latin1')
    def send(self, s): self.p.stdin.write(s.encode()); self.p.stdin.flush()
    def wait_for(self, rx, timeout):
        end = time.time() + timeout
        while time.time() < end:
            if re.search(rx, self.text()): return time.time() - self.t0
            if self.p.poll() is not None: raise RuntimeError('qemu exited early:\n' + self.text()[-1500:])
            time.sleep(0.5)
        raise TimeoutError(f'timeout waiting for {rx!r}; screen tail:\n' + self.text()[-1500:])
    def qmp(self):
        for _ in range(60):
            try:
                s = socket.socket(socket.AF_UNIX); s.connect(self.sock); break
            except OSError: time.sleep(0.5)
        else: raise RuntimeError('no QMP socket')
        f = s.makefile('rw'); f.readline()
        def cmd(name, **args):
            f.write(json.dumps({'execute': name, 'arguments': args}) + '\n'); f.flush()
            while True:
                r = json.loads(f.readline())
                if 'return' in r: return r['return']
                if 'error' in r: raise RuntimeError(r['error'])
        cmd('qmp_capabilities'); return cmd
    def stop(self):
        try: self.p.kill()
        except Exception: pass

ok = False
try:
    os.makedirs('report', exist_ok=True)
    shutil.copy('out/rootfs.img', DISK)
    start_dummy_peer()

    log('== 1. native boot of stock Arch (TCG, no KVM) ==')
    vm = VM(machine_args(DISK), '/tmp/q1.sock')
    t_login = vm.wait_for(r'archlinux login:', 1500)
    log(f'login prompt reached after {t_login:.1f}s')
    t_boot = vm.wait_for(r'\[root@[^\]]+\]#', 180)
    log(f'root shell reached after {t_boot:.1f}s')
    vm.send('sync; echo 3 > /proc/sys/vm/drop_caches; echo PRE-SNAP-$((6*7))\r'); vm.wait_for(r'PRE-SNAP-42', 60); time.sleep(5)
    log('free memory in guest:'); vm.send('free -m\r'); time.sleep(2); log(vm.text()[-400:])

    log('== 2. save machine state (migrate to file) ==')
    cmd = vm.qmp(); t = time.time()
    cmd('migrate', uri='file:' + STATE)
    while True:
        st = cmd('query-migrate').get('status')
        if st in ('completed', 'failed', 'cancelled'): break
        time.sleep(1)
        if time.time() - t > 900: raise TimeoutError('migration timeout')
    log(f'migration {st} in {time.time()-t:.1f}s; state.bin = {os.path.getsize(STATE)/1048576:.0f} MB')
    if st != 'completed': raise RuntimeError('migration did not complete')
    try: cmd('quit')
    except Exception: pass
    vm.p.wait(timeout=60)

    log('== 3. restore test, natively (on a copy of the disk) ==')
    tmp = '/tmp/rootfs-restore-test.img'; shutil.copy(DISK, tmp)
    vm2 = VM(machine_args(tmp) + ['-incoming', 'file:' + STATE], '/tmp/q2.sock'); t = time.time()
    time.sleep(3); vm2.send('\recho SNAP-OK-$((6*7))\r')
    t_res = vm2.wait_for(r'SNAP-OK-42', 300)
    log(f'restored and answered a command {t_res:.1f}s after start')
    vm2.stop(); ok = True
except Exception:
    log('FAILED:\n' + traceback.format_exc())
finally:
    REPORT.close()
sys.exit(0 if ok else 1)
