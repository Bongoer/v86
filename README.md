# v64

v64 is an experimental graphical x86_64 virtual machine for Chromium-based browsers. It uses QEMU Wasm instead of v86 because upstream v86 doesn't implement 64-bit guests.

## What is and isn't included

No operating-system ISO is bundled or downloaded by this project.

The user supplies their own Tiny10, Tiny11, Ubuntu, Zorin OS, or other x86_64 ISO from the browser's file picker. The preset names only choose hardware settings.

## First deployment

1. Replace the contents of `Bongoer/v86` with this ZIP.
2. Commit and push the files.
3. Open `Settings`, then `Pages`.
4. Under `Build and deployment`, select `GitHub Actions`.
5. Open `Actions` and wait for `Deploy v64`.
6. Visit `https://bongoer.github.io/v86/`.

The action downloads a pinned graphical QEMU Wasm build and creates three sparse blank QCOW2 disks. The large engine isn't stored in your Git repository.

## How storage works

- ISO: read directly from the user's local `File` object inside a worker. It isn't copied into the WebAssembly heap and isn't uploaded.
- VM disk: stored in the browser's Origin Private File System (OPFS).
- Disk I/O: a dedicated storage worker handles random reads and writes while QEMU runs.
- Persistence: the same VM name reopens the same browser disk.
- Export: before boot, `Export disk` downloads the saved QCOW2 or raw image.

## Practical limits

- Chromium is recommended. The experimental SDL/OffscreenCanvas build is unreliable in Firefox.
- There is no hardware virtualization. The guest CPU is translated by QEMU TCG and will be much slower than UTM, VirtualBox, or native QEMU.
- Networking and audio are disabled in this first graphical build.
- Tiny10 is a more realistic target than Tiny11.
- Ubuntu or Zorin live mode is a better first test than a full installation.

## Credits

- QEMU Wasm: https://github.com/ktock/qemu-wasm
- Experimental graphical build: https://github.com/zb3/qemu-wasm-test
- Cross-origin isolation service worker: https://github.com/gzuidhof/coi-serviceworker

See `THIRD_PARTY_NOTICES.md` for license details.
