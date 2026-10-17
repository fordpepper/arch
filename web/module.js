// Boot arguments for qemu-system-x86_64 (wasm). Files live in /pack (preloaded by file_packager).
Module['arguments'] = [
  '-nographic', '-m', '1024M', '-accel', 'tcg,tb-size=500',
  '-L', '/pack/',
  '-nic', 'none',
  '-drive', 'if=virtio,format=raw,file=/pack/rootfs.img',
  '-kernel', '/pack/vmlinuz',
  '-initrd', '/pack/initramfs.img',
  '-append', 'console=ttyS0,115200n8 root=/dev/vda rw rootwait loglevel=4',
];
