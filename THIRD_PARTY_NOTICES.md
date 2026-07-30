# Third-party notices

## QEMU and QEMU Wasm

The deployed site uses a pinned graphical build from:

- https://github.com/ktock/qemu-wasm
- https://github.com/zb3/qemu-wasm-test

QEMU is distributed under the GNU General Public License version 2. The deployment workflow copies the corresponding `COPYING` file into the published site.

## coi-serviceworker

`coi-serviceworker.js` is from:

- https://github.com/gzuidhof/coi-serviceworker

It is distributed under the MIT License.

## Operating systems

The deployment workflow downloads Debian's official generic amd64 cloud image
and publishes it as a ready-to-boot option. Debian is made of free and
open-source software under its component licenses:

- https://www.debian.org/legal/licenses/
- https://cloud.debian.org/images/cloud/

This repository contains no Windows, Tiny10, Tiny11, Ubuntu, Zorin OS, or other
operating-system ISO. Users must provide those files and comply with the
applicable licenses.
