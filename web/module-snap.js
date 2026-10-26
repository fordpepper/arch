// Same machine as scripts/native-snapshot.py, but resuming from the saved state instead of booting.
Module['arguments'] = [
  '-nographic', '-m', '512M', '-accel', 'tcg,tb-size=500',
  '-L', '/pack/',
  '-nic', 'none',
  '-drive', 'if=virtio,format=raw,file=/pack/rootfs.img',
  '-kernel', '/pack/vmlinuz',
  '-initrd', '/pack/initramfs.img',
  '-append', 'console=ttyS0,115200n8 root=/dev/vda rw rootwait loglevel=4 init_on_free=1',
  '-incoming', 'file:/pack/state.bin',
];
