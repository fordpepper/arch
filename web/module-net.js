// Same machine as scripts/native-snapshot-net.py (same options, same order), resuming from the saved state.
Module['arguments'] = [
  '-nographic', '-m', '512M', '-accel', 'tcg,tb-size=500',
  '-L', '/pack/',
  '-drive', 'if=virtio,format=raw,file=/pack/rootfs.img',
  '-kernel', '/pack/vmlinuz',
  '-initrd', '/pack/initramfs.img',
  '-append', 'console=ttyS0,115200n8 root=/dev/vda rw rootwait loglevel=4 init_on_free=1 virtio_net.napi_tx=false',
  '-virtfs', 'local,path=/.wasmenv,mount_tag=wasm0,security_model=passthrough,id=wasm0',
  '-netdev', 'socket,id=vmnic,connect=localhost:8888', '-device', 'virtio-net-pci,netdev=vmnic,mac=02:00:00:00:00:01',
  '-incoming', 'file:/pack/state.bin',
];
