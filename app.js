const $ = (id) => document.getElementById(id);

const elements = {
  setup: $("setup"),
  vmShell: $("vm-shell"),
  status: $("status"),
  statusLight: $("status-light"),
  preset: $("preset"),
  vmName: $("vm-name"),
  memory: $("memory"),
  cores: $("cores"),
  diskSize: $("disk-size"),
  iso: $("iso"),
  isoName: $("iso-name"),
  diskImage: $("disk-image"),
  diskName: $("disk-name"),
  storage: $("storage"),
  exportDisk: $("export-disk"),
  resetDisk: $("reset-disk"),
  start: $("start"),
  hint: $("hint"),
  canvas: $("canvas"),
  log: $("log"),
  runStatus: $("run-status"),
  fullscreen: $("fullscreen"),
  keyboard: $("keyboard"),
  restart: $("restart")
};

const presets = {
  debian: {
    memory: 768,
    cores: 1,
    disk: 16,
    premade: true,
    hint: "Debian 13 boots from an official ready-made disk. First start downloads about 420 MB into this browser."
  },
  tiny11: {
    memory: 1280,
    cores: 2,
    disk: 64,
    hint: "Tiny11 still needs patience. A clean installation can take a long time in browser emulation."
  },
  tiny10: {
    memory: 1024,
    cores: 2,
    disk: 32,
    hint: "Tiny10 is the more realistic Windows choice for a browser VM."
  },
  ubuntu: {
    memory: 1024,
    cores: 2,
    disk: 32,
    hint: "Try the live session first. Installing the full desktop is much slower."
  },
  zorin: {
    memory: 1280,
    cores: 2,
    disk: 32,
    hint: "Zorin's desktop is heavy. Zorin Lite is the friendlier ISO for this emulator."
  },
  custom: {
    memory: 1024,
    cores: 2,
    disk: 32,
    hint: "Use a 64-bit x86 ISO. ARM64 images won't boot in this machine."
  }
};

const romNames = [
  "bios-256k.bin",
  "vgabios-stdvga.bin",
  "kvmvapic.bin",
  "linuxboot_dma.bin"
];

let supported = false;
let storageWorker = null;
let vmStarted = false;
let hasSavedDisk = false;

function setStatus(message, state = "") {
  elements.status.textContent = message;
  elements.statusLight.className = `status-light ${state}`.trim();
}

function appendLog(message) {
  const text = String(message);
  elements.log.textContent += `${text}\n`;
  elements.log.scrollTop = elements.log.scrollHeight;
}

function safeVmName() {
  return (elements.vmName.value || "main")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "main";
}

function diskKey() {
  return `v64-${safeVmName()}.disk`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit < 2 ? 0 : 1)} ${units[unit]}`;
}

function updateStartButton() {
  const iso = elements.iso.files[0];
  const disk = elements.diskImage.files[0];
  const premade = Boolean(presets[elements.preset.value].premade);
  elements.start.disabled =
    !supported || (!premade && !iso && !disk && !hasSavedDisk);
}

function updatePreset() {
  const preset = presets[elements.preset.value];
  const deviceMemory = Number(navigator.deviceMemory || 8);
  const memoryLimit = deviceMemory <= 4 ? 768 : deviceMemory <= 6 ? 1024 : 1536;
  elements.memory.value = String(Math.min(preset.memory, memoryLimit));
  elements.cores.value = String(Math.min(
    preset.cores,
    Math.max(1, navigator.hardwareConcurrency || 2)
  ));
  elements.diskSize.value = String(preset.disk);
  elements.hint.textContent = preset.hint;
  if (preset.premade && elements.vmName.value === "main") {
    elements.vmName.value = "debian";
  }
  refreshSavedDisk();
}

function updateFiles() {
  const iso = elements.iso.files[0];
  const disk = elements.diskImage.files[0];
  elements.isoName.textContent = iso
    ? `${iso.name} (${formatBytes(iso.size)})`
    : "Choose ISO";
  elements.diskName.textContent = disk
    ? `${disk.name} (${formatBytes(disk.size)})`
    : "Choose QCOW2 / IMG";
  updateStartButton();
}

async function updateStorage() {
  if (!navigator.storage?.estimate) {
    elements.storage.textContent = "Storage estimate unavailable";
    return;
  }
  const estimate = await navigator.storage.estimate();
  const free = Math.max(0, (estimate.quota || 0) - (estimate.usage || 0));
  elements.storage.textContent = `${formatBytes(free)} browser storage available`;
}

async function getDiskFile(create = false) {
  const root = await navigator.storage.getDirectory();
  try {
    const handle = await root.getFileHandle(diskKey(), { create });
    return { root, handle, file: await handle.getFile() };
  } catch (error) {
    if (error.name === "NotFoundError") return null;
    throw error;
  }
}

async function refreshSavedDisk() {
  try {
    const disk = await getDiskFile(false);
    hasSavedDisk = Boolean(disk?.file?.size);
  } catch {
    hasSavedDisk = false;
  }
  updateStartButton();
}

async function detectDiskFormat(file) {
  const magic = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return magic.length === 4 &&
    magic[0] === 0x51 &&
    magic[1] === 0x46 &&
    magic[2] === 0x49 &&
    magic[3] === 0xfb
    ? "qcow2"
    : "raw";
}

async function importDisk(file) {
  elements.start.disabled = true;
  setStatus(`Importing ${file.name}...`);
  const format = await detectDiskFormat(file);
  const { handle } = await getDiskFile(true);
  const writable = await handle.createWritable();
  await file.stream().pipeTo(writable);
  localStorage.setItem(`${diskKey()}:format`, format);
  hasSavedDisk = true;
  setStatus(`${format.toUpperCase()} disk imported`, "ready");
  return format;
}

async function exportDisk() {
  try {
    const disk = await getDiskFile(false);
    if (!disk?.file?.size) {
      setStatus("No saved disk exists for this VM", "error");
      return;
    }
    const url = URL.createObjectURL(disk.file);
    const link = document.createElement("a");
    const format = localStorage.getItem(`${diskKey()}:format`) || "qcow2";
    link.href = url;
    link.download = `${safeVmName()}.${format === "raw" ? "img" : "qcow2"}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    setStatus(`Exporting ${formatBytes(disk.file.size)} disk`, "ready");
  } catch (error) {
    console.error(error);
    setStatus(`Export failed: ${error.message}`, "error");
  }
}

async function resetDisk() {
  if (!confirm(`Delete the saved disk for "${safeVmName()}"? This can't be undone.`)) return;
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(diskKey());
    localStorage.removeItem(`${diskKey()}:format`);
    hasSavedDisk = false;
    setStatus("Saved disk deleted", "ready");
    await updateStorage();
    updateStartButton();
  } catch (error) {
    if (error.name === "NotFoundError") {
      hasSavedDisk = false;
      setStatus("There was no saved disk to delete", "ready");
      updateStartButton();
      return;
    }
    console.error(error);
    setStatus(`Reset failed: ${error.message}`, "error");
  }
}

function workerRequest(worker, message, onProgress) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const onMessage = (event) => {
      if (event.data?.requestId !== requestId) return;
      if (event.data.progress) {
        onProgress?.(event.data.progress);
        return;
      }
      worker.removeEventListener("message", onMessage);
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data);
    };
    worker.addEventListener("message", onMessage);
    worker.postMessage({ ...message, requestId });
  });
}

async function loadRoms() {
  return Promise.all(romNames.map(async (name) => {
    const response = await fetch(`./engine/rom/${name}`);
    if (!response.ok) throw new Error(`Missing ROM: ${name}`);
    return { name, bytes: new Uint8Array(await response.arrayBuffer()) };
  }));
}

async function loadDebianSeed() {
  const response = await fetch("./engine/disks/debian-seed.iso");
  if (!response.ok) {
    throw new Error(`Missing Debian setup disk (${response.status})`);
  }
  return response.blob();
}

async function loadDebianDiskManifest() {
  const response = await fetch("./engine/disks/debian/manifest.json");
  if (!response.ok) {
    throw new Error(`Missing Debian disk manifest (${response.status})`);
  }
  const manifest = await response.json();
  if (!Array.isArray(manifest.parts) || !manifest.parts.length) {
    throw new Error("The Debian disk manifest has no parts");
  }
  return {
    total: Number(manifest.size || 0),
    urls: manifest.parts.map((part) =>
      new URL(`./engine/disks/debian/${part}`, location.href).href
    )
  };
}

function qemuArguments({ iso, seed, diskFormat }) {
  const memory = Number(elements.memory.value);
  const cores = Number(elements.cores.value);
  const phone = matchMedia("(max-width: 760px)").matches;
  const tbSize = phone ? 192 : 320;
  const args = [
    "-display", "sdl",
    "-M", "pc",
    "-cpu", "max",
    "-m", `${memory}M`,
    "-smp", `${cores},sockets=1,cores=${cores},threads=1`,
    "-accel", `tcg,tb-size=${tbSize},thread=multi`,
    "-L", "/v64/rom",
    "-vga", "std",
    "-device", "usb-tablet",
    "-netdev", "user,id=v64net,restrict=on",
    "-device", "e1000,netdev=v64net,romfile=",
    "-rtc", "base=localtime",
    "-drive", `file=/v64/disk.img,format=${diskFormat},if=ide,index=0,cache=writeback,aio=threads`
  ];

  if (iso) {
    args.push(
      "-drive", "file=/v64/installer.iso,media=cdrom,readonly=on,if=ide,index=2",
      "-boot", "order=d,menu=on"
    );
  } else if (seed) {
    args.push(
      "-drive", "file=/v64/debian-seed.iso,media=cdrom,readonly=on,if=ide,index=2",
      "-boot", "order=c,menu=on"
    );
  } else {
    args.push("-boot", "order=c,menu=on");
  }
  return args;
}

async function startVm() {
  if (vmStarted) return;
  const iso = elements.iso.files[0] || null;
  const diskImport = elements.diskImage.files[0] || null;
  const preset = presets[elements.preset.value];
  const wantsDebian = Boolean(preset.premade && !iso && !diskImport);
  let diskFormat = diskImport
    ? null
    : localStorage.getItem(`${diskKey()}:format`) || "qcow2";

  vmStarted = true;
  elements.start.disabled = true;
  elements.exportDisk.disabled = true;
  elements.resetDisk.disabled = true;
  setStatus("Preparing persistent disk...");

  try {
    if (diskImport) {
      diskFormat = await importDisk(diskImport);
    }

    await navigator.storage.persist?.();
    storageWorker = new Worker("./storage-worker.js", { type: "module" });
    storageWorker.addEventListener("message", (event) => {
      if (event.data?.type !== "disk-error") return;
      appendLog(`Disk error: ${event.data.error}`);
      elements.runStatus.textContent = "Virtual disk error";
    });

    const existingDisk = await getDiskFile(false);
    let seedUrls = [];
    let seedTotal = 0;
    if (!existingDisk?.file?.size) {
      if (wantsDebian) {
        const manifest = await loadDebianDiskManifest();
        seedUrls = manifest.urls;
        seedTotal = manifest.total;
      } else {
        seedUrls = [
          new URL(
            `./engine/disks/blank-${elements.diskSize.value}g.qcow2`,
            location.href
          ).href
        ];
      }
    }

    const prepared = await workerRequest(storageWorker, {
      cmd: "prepare",
      diskKey: diskKey(),
      seedUrls,
      seedTotal,
      expectedFormat: diskFormat
    }, ({ loaded, total }) => {
      const percent = total ? Math.round(loaded * 100 / total) : 0;
      setStatus(`Preparing disk... ${percent}%`);
    });

    diskFormat = prepared.format;
    localStorage.setItem(`${diskKey()}:format`, diskFormat);
    hasSavedDisk = true;

    setStatus("Loading graphical x86_64 engine...");
    const [roms, debianSeed] = await Promise.all([
      loadRoms(),
      wantsDebian ? loadDebianSeed() : Promise.resolve(null)
    ]);

    const moduleConfig = {
      arguments: qemuArguments({ iso, seed: debianSeed, diskFormat }),
      canvas: elements.canvas,
      v64ISO: iso,
      v64Seed: debianSeed,
      v64Roms: roms,
      v64DiskSize: prepared.size,
      v64StorageWorker: storageWorker,
      locateFile(path) {
        return new URL(`./engine/${path}`, location.href).href;
      },
      mainScriptUrlOrBlob: new URL(
        "./engine/qemu-system-x86_64.js",
        location.href
      ).href,
      print(...args) {
        appendLog(args.join(" "));
      },
      printErr(...args) {
        appendLog(args.join(" "));
      },
      setStatus(message) {
        if (message) elements.runStatus.textContent = message;
      },
      onRuntimeInitialized() {
        elements.runStatus.textContent = "VM running";
        elements.canvas.focus();
      },
      onAbort(reason) {
        elements.runStatus.textContent = `VM stopped: ${reason}`;
        appendLog(`Abort: ${reason}`);
      }
    };

    elements.setup.classList.add("hidden");
    elements.vmShell.classList.remove("hidden");
    elements.runStatus.textContent = "Starting x86_64 machine...";

    const { default: initQemu } = await import(
      "./engine/qemu-system-x86_64.js"
    );
    await initQemu(moduleConfig);
  } catch (error) {
    console.error(error);
    vmStarted = false;
    storageWorker?.terminate();
    storageWorker = null;
    elements.setup.classList.remove("hidden");
    elements.vmShell.classList.add("hidden");
    elements.exportDisk.disabled = false;
    elements.resetDisk.disabled = false;
    setStatus(`Start failed: ${error.message || error}`, "error");
    await refreshSavedDisk();
  }
}

async function checkSupport() {
  if (!globalThis.crossOriginIsolated) {
    setStatus("Enabling browser isolation, the page may reload once...");
    return;
  }

  const missing = [];
  if (!globalThis.SharedArrayBuffer) missing.push("SharedArrayBuffer");
  if (!globalThis.OffscreenCanvas) missing.push("OffscreenCanvas");
  if (!navigator.storage?.getDirectory) missing.push("OPFS storage");
  if (!globalThis.Worker) missing.push("Web Workers");

  if (missing.length) {
    setStatus(`Unsupported browser: missing ${missing.join(", ")}`, "error");
    elements.hint.textContent =
      "Use a current Chromium-based browser. Firefox isn't reliable with this graphical QEMU build.";
    return;
  }

  supported = true;
  setStatus("Browser ready", "ready");
  updateFiles();
  await Promise.all([updateStorage(), refreshSavedDisk()]);
}

elements.preset.addEventListener("change", updatePreset);
elements.iso.addEventListener("change", updateFiles);
elements.diskImage.addEventListener("change", updateFiles);
elements.vmName.addEventListener("input", () => {
  updateStorage();
  refreshSavedDisk();
});
elements.start.addEventListener("click", startVm);
elements.exportDisk.addEventListener("click", exportDisk);
elements.resetDisk.addEventListener("click", resetDisk);
elements.restart.addEventListener("click", () => location.reload());
elements.fullscreen.addEventListener("click", async () => {
  if (document.fullscreenElement) await document.exitFullscreen();
  else await elements.vmShell.requestFullscreen();
  elements.canvas.focus();
});
elements.keyboard.addEventListener("click", () => {
  elements.canvas.focus();
  const input = document.createElement("input");
  input.style.position = "fixed";
  input.style.opacity = "0";
  input.style.pointerEvents = "none";
  document.body.appendChild(input);
  input.focus();
  setTimeout(() => {
    elements.canvas.focus();
    input.remove();
  }, 250);
});
elements.canvas.addEventListener("pointerdown", () => elements.canvas.focus());
elements.canvas.addEventListener("webglcontextlost", (event) => {
  event.preventDefault();
  elements.runStatus.textContent = "Graphics context lost. Tap Restart.";
});

updatePreset();
updateFiles();
checkSupport();
