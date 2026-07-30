# v64

v64 is an experimental graphical x86_64 virtual machine for Chromium-based
browsers. It uses QEMU Wasm because upstream v86 doesn't implement 64-bit
guests.

## Included systems

- Debian 13 has a ready-to-boot official x86_64 disk.
- Debian login: `debian`
- Debian password: `debian`
- Tiny10, Tiny11, Ubuntu, Zorin OS, and custom systems aren't included. The
  user supplies those as an ISO.

The first Debian start copies about 420 MB into the browser's private storage.
The published Debian disk is split into sub-100 MB files so GitHub accepts the
deployment branch.

## First deployment

1. Replace the contents of `Bongoer/v86` with this ZIP.
2. Commit and push the files.
3. Wait for the `Build v64` action to finish. It creates the `gh-pages` branch.
4. Open `Settings`, then `Pages`.
5. Under `Build and deployment`, choose `Deploy from a branch`.
6. Select the `gh-pages` branch and `/ (root)`, then save.
7. Visit `https://bongoer.github.io/v86/`.

This workflow doesn't use `actions/configure-pages`, so it avoids the Pages API
404 that blocked the earlier package.

## Storage

- ISO files stay on the user's device and aren't uploaded.
- VM disks are stored in the browser's Origin Private File System.
- A dedicated storage worker handles random disk reads and writes.
- The same VM name reopens the same browser disk.
- Export downloads the saved QCOW2 or raw image.
- Imported disk formats are detected from the file header instead of trusting
  the filename.

## Practical limits

- Use a current Chromium-based browser.
- There is no hardware virtualization. QEMU TCG is much slower than UTM,
  VirtualBox, or native QEMU.
- Outbound networking and audio are disabled. An isolated QEMU DHCP network is
  used only to avoid Debian's long wait-online delay.
- Tiny10 is a more realistic browser target than Tiny11.
- Ubuntu or Zorin live mode is a better first test than a full installation.

## Credits

- QEMU Wasm: https://github.com/ktock/qemu-wasm
- Experimental graphical build: https://github.com/zb3/qemu-wasm-test
- Debian cloud images: https://cloud.debian.org/images/cloud/
- Cross-origin isolation service worker: https://github.com/gzuidhof/coi-serviceworker

See `THIRD_PARTY_NOTICES.md` for license details.
