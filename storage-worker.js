let accessHandle = null;
let diskSize = 0;
let dirtyBytes = 0;
const ports = new Set();

function reply(target, requestId, data = {}, error = null) {
  target.postMessage({ requestId, ...data, error });
}

function sendProgress(target, requestId, loaded, total) {
  target.postMessage({
    requestId,
    progress: { loaded, total }
  });
}

async function closeDisk() {
  if (!accessHandle) return;
  accessHandle.flush();
  accessHandle.close();
  accessHandle = null;
  dirtyBytes = 0;
}

async function seedDisk(seedUrls, seedTotal, target, requestId) {
  const urls = Array.isArray(seedUrls) ? seedUrls : [];
  const total = Number(seedTotal || 0);
  let position = 0;
  let lastProgress = 0;
  accessHandle.truncate(0);

  try {
    for (const url of urls) {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Couldn't load a starter disk part (${response.status})`);
      }
      if (!response.body) {
        throw new Error("The browser couldn't stream the starter disk");
      }

      const reader = response.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        const written = accessHandle.write(value, { at: position });
        if (written !== value.byteLength) {
          throw new Error("The browser only wrote part of the starter disk");
        }
        position += written;
        if (position - lastProgress >= 8 * 1024 * 1024 || position === total) {
          sendProgress(target, requestId, position, total);
          lastProgress = position;
        }
      }
    }
    accessHandle.flush();
    diskSize = accessHandle.getSize();
    sendProgress(target, requestId, diskSize, total || diskSize);
  } catch (error) {
    accessHandle.truncate(0);
    accessHandle.flush();
    diskSize = 0;
    throw error;
  }
}

function detectFormat() {
  if (diskSize < 4) return null;
  const magic = new Uint8Array(4);
  const read = accessHandle.read(magic, { at: 0 });
  if (read !== 4) return null;
  return magic[0] === 0x51 &&
    magic[1] === 0x46 &&
    magic[2] === 0x49 &&
    magic[3] === 0xfb
    ? "qcow2"
    : "raw";
}

async function prepareDisk(
  { diskKey, seedUrls, seedTotal, expectedFormat },
  target,
  requestId
) {
  await closeDisk();
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(diskKey, { create: true });
  accessHandle = await handle.createSyncAccessHandle();
  diskSize = accessHandle.getSize();

  if (diskSize === 0 && seedUrls?.length) {
    await seedDisk(seedUrls, seedTotal, target, requestId);
  }
  if (diskSize === 0) {
    throw new Error("The virtual disk is empty. Reset it and try again.");
  }

  const format = detectFormat();
  if (!format) {
    throw new Error("The virtual disk couldn't be read.");
  }
  if (expectedFormat && expectedFormat !== format) {
    throw new Error(
      `The saved disk is ${format.toUpperCase()}, not ${expectedFormat.toUpperCase()}. Reset or re-import it.`
    );
  }
  return { size: diskSize, format };
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
    if (!accessHandle) {
      throw new Error("The persistent disk isn't open");
    }

    let result = 0;
    if (message.op === "read") {
      result = accessHandle.read(bytes.subarray(0, message.length), {
        at: message.position
      });
    } else if (message.op === "write") {
      result = accessHandle.write(bytes.subarray(0, message.length), {
        at: message.position
      });
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
    self.postMessage({
      type: "disk-error",
      error: error.message || String(error)
    });
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
      const prepared = await prepareDisk(
        message,
        self,
        message.requestId
      );
      reply(self, message.requestId, prepared);
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
