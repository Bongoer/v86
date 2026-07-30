let accessHandle = null;
let diskSize = 0;
let dirtyBytes = 0;
const ports = new Set();

function reply(target, requestId, data = {}, error = null) {
  target.postMessage({ requestId, ...data, error });
}

async function closeDisk() {
  if (!accessHandle) return;
  accessHandle.flush();
  accessHandle.close();
  accessHandle = null;
  dirtyBytes = 0;
}

async function prepareDisk({ diskKey, seedUrl, useSeed }) {
  await closeDisk();
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(diskKey, { create: true });
  accessHandle = await handle.createSyncAccessHandle();
  diskSize = accessHandle.getSize();

  if (diskSize === 0 && useSeed) {
    const response = await fetch(seedUrl);
    if (!response.ok) throw new Error(`Couldn't load blank disk (${response.status})`);
    const seed = new Uint8Array(await response.arrayBuffer());
    accessHandle.write(seed, { at: 0 });
    accessHandle.flush();
    diskSize = seed.byteLength;
  }

  return diskSize;
}

function finishControl(control, result, size = diskSize, error = 0) {
  Atomics.store(control, 1, result | 0);
  Atomics.store(control, 2, size >>> 0);
  Atomics.store(control, 3, Math.floor(size / 0x100000000) >>> 0);
  Atomics.store(control, 0, error ? -Math.abs(error) : 1);
  Atomics.notify(control, 0);
}

function handleDiskRequest(message) {
  const control = new Int32Array(message.control);
  const bytes = new Uint8Array(message.data);
  try {
    let result = 0;
    if (message.op === "read") {
      result = accessHandle.read(bytes.subarray(0, message.length), { at: message.position });
    } else if (message.op === "write") {
      result = accessHandle.write(bytes.subarray(0, message.length), { at: message.position });
      diskSize = Math.max(diskSize, message.position + result);
      dirtyBytes += result;
      if (dirtyBytes >= 16 * 1024 * 1024) {
        accessHandle.flush();
        dirtyBytes = 0;
      }
    } else if (message.op === "truncate") {
      accessHandle.truncate(message.size);
      diskSize = message.size;
    } else if (message.op === "flush") {
      accessHandle.flush();
      dirtyBytes = 0;
    } else if (message.op === "size") {
      diskSize = accessHandle.getSize();
    } else {
      throw new Error(`Unknown disk operation: ${message.op}`);
    }
    finishControl(control, result);
  } catch (error) {
    console.error(error);
    finishControl(control, 0, diskSize, 5);
  }
}

self.addEventListener("message", async (event) => {
  const message = event.data || {};
  if (message.cmd === "attach" && message.port) {
    const port = message.port;
    ports.add(port);
    port.onmessage = (portEvent) => handleDiskRequest(portEvent.data);
    port.start();
    return;
  }

  if (message.cmd === "prepare") {
    try {
      const size = await prepareDisk(message);
      reply(self, message.requestId, { size });
    } catch (error) {
      reply(self, message.requestId, {}, error.message || String(error));
    }
  }
});

setInterval(() => {
  if (!accessHandle || !dirtyBytes) return;
  try {
    accessHandle.flush();
    dirtyBytes = 0;
  } catch (error) {
    console.error(error);
  }
}, 5000);
