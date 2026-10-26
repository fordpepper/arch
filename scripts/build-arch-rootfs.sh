#!/bin/bash
# Runs INSIDE the official archlinux Docker image (privileged).
# Output: /out/root (file tree), /out/vmlinuz, /out/initramfs.img
set -euxo pipefail

# Smaller image: skip man pages, docs, info and translations (the only deviation from a stock install).
if [ "${TRIM:-1}" = 1 ]; then
  sed -i 's|^#\?NoExtract.*||' /etc/pacman.conf
  sed -i '/^\[options\]/a NoExtract = usr/share/man/* usr/share/doc/* usr/share/info/* usr/share/locale/*' /etc/pacman.conf
fi

pacman -Sy --noconfirm archlinux-keyring arch-install-scripts
pacman-key --init
pacman-key --populate archlinux

rm -rf /out/root && mkdir -p /out/root
pacstrap -K /out/root base linux

echo "=== SIZE BREAKDOWN of the installed system (MB) ==="
du -xm --max-depth=2 /out/root 2>/dev/null | sort -rn | head -25
if [ "${DROP_FIRMWARE:-0}" = 1 ]; then
  # A VM has no real hardware, so hardware firmware blobs are dead weight.
  arch-chroot /out/root bash -c 'pacman -Qq | grep "^linux-firmware" | xargs -r pacman -Rdd --noconfirm' || true
  echo "=== after removing firmware packages ==="
  du -xsm /out/root
fi

# Normal post-install configuration (what archinstall would also do)
echo archlinux > /out/root/etc/hostname
echo 'LANG=en_US.UTF-8' > /out/root/etc/locale.conf
sed -i 's/^#en_US.UTF-8/en_US.UTF-8/' /out/root/etc/locale.gen
arch-chroot /out/root locale-gen
arch-chroot /out/root ln -sf /usr/share/zoneinfo/UTC /etc/localtime

# Serial console login (the browser terminal is the serial port)
mkdir -p /out/root/etc/systemd/system/serial-getty@ttyS0.service.d
cat > /out/root/etc/systemd/system/serial-getty@ttyS0.service.d/autologin.conf <<'UNIT'
[Service]
ExecStart=
ExecStart=-/sbin/agetty -o '-p -f -- \\u' --autologin root --noclear --keep-baud 115200,38400,9600 %I $TERM
UNIT

# Network (not used in the first spike, but standard archinstall-style config)
cat > /out/root/etc/systemd/network/20-wired.network <<'NET'
[Match]
Name=en* eth*

[Network]
DHCP=yes
NET
arch-chroot /out/root systemctl enable systemd-networkd systemd-resolved
ln -sf ../run/systemd/resolve/stub-resolv.conf /out/root/etc/resolv.conf

# Kernel + the "fallback" initramfs (it contains all drivers, e.g. virtio_blk)
ls -la /out/root/boot || true
cp /out/root/boot/vmlinuz-linux /out/vmlinuz
# Current Arch ships only the 'default' preset; older ones also had 'fallback'.
# Inside a container autodetect cannot trim the image, so it keeps all drivers either way.
if [ -e /out/root/boot/initramfs-linux-fallback.img ]; then
  cp /out/root/boot/initramfs-linux-fallback.img /out/initramfs.img
else
  cp /out/root/boot/initramfs-linux.img /out/initramfs.img
fi
# Report whether the virtio disk driver is inside the initramfs (informational only)
n=$( (zstd -dc /out/initramfs.img 2>/dev/null || cat /out/initramfs.img) | (cpio -t 2>/dev/null || true) | grep -c 'virtio_blk' || true )
echo "virtio_blk entries in initramfs: ${n:-0}"
# /boot is not needed inside the disk image because qemu loads the kernel directly
rm -f /out/root/boot/initramfs-linux*.img
echo "ROOTFS_DONE"
