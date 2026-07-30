import fs from "node:fs";

const target = process.argv[2];
if (!target) {
  throw new Error("Usage: node scripts/patch-engine.mjs <qemu-system-x86_64.js>");
}

let source = fs.readFileSync(target, "utf8");
const original = source;

function replaceOnce(search, replacement, label) {
  const index = source.indexOf(search);
  if (index < 0) throw new Error(`Engine patch point missing: ${label}`);
  if (source.indexOf(search, index + search.length) >= 0) {
    throw new Error(`Engine patch point isn't unique: ${label}`);
  }
  source = source.replace(search, replacement);
}

replaceOnce(
  "var startWorker;\n\nif (ENVIRONMENT_IS_PTHREAD) {",
  `var startWorker;
var v64WorkerConfig = null;
var v64PreopenedFiles = Object.create(null);
var v64PreopenedFds = new Set();

function v64Preopen(path, flags) {
  var stream = FS.open(path, flags);
  v64PreopenedFiles[path] = stream.fd;
  v64PreopenedFds.add(stream.fd);
  return stream.fd;
}

function v64IsPreopenedFD(fd) {
  return v64PreopenedFds.has(fd);
}

function v64CreateBlobFile(parent, name, blob, canWrite) {
  var node = FS.createFile(parent, name, {}, true, canWrite);
  var reader = new FileReaderSync();
  var overlays = new Map();
  var chunkSize = 1024 * 1024;
  var fileSize = blob.size;
  var originalNodeOps = node.node_ops;

  function readChunk(chunkIndex) {
    var cached = overlays.get(chunkIndex);
    if (cached) return cached;
    var start = chunkIndex * chunkSize;
    var end = Math.min(start + chunkSize, blob.size);
    if (start >= blob.size) return new Uint8Array(chunkSize);
    return new Uint8Array(reader.readAsArrayBuffer(blob.slice(start, end)));
  }

  node.node_ops = Object.assign({}, originalNodeOps, {
    setattr(targetNode, attr) {
      for (var key of [ "mode", "atime", "mtime", "ctime" ]) {
        if (attr[key] != null) targetNode[key] = attr[key];
      }
      if (attr.size !== undefined) fileSize = attr.size;
    }
  });

  node.stream_ops = Object.assign({}, node.stream_ops, {
    read(stream, buffer, offset, length, position) {
      if (position >= fileSize) return 0;
      var remaining = Math.min(length, fileSize - position);
      var total = remaining;
      while (remaining > 0) {
        var chunkIndex = Math.floor(position / chunkSize);
        var chunkOffset = position % chunkSize;
        var chunk = readChunk(chunkIndex);
        var amount = Math.min(remaining, chunk.length - chunkOffset);
        buffer.set(chunk.subarray(chunkOffset, chunkOffset + amount), offset);
        offset += amount;
        position += amount;
        remaining -= amount;
      }
      return total;
    },
    write(stream, buffer, offset, length, position) {
      if (!canWrite) throw new FS.ErrnoError(2);
      var remaining = length;
      while (remaining > 0) {
        var chunkIndex = Math.floor(position / chunkSize);
        var chunkOffset = position % chunkSize;
        var chunk = overlays.get(chunkIndex);
        if (!chunk) {
          var original = readChunk(chunkIndex);
          chunk = new Uint8Array(chunkSize);
          chunk.set(original);
          overlays.set(chunkIndex, chunk);
        }
        var amount = Math.min(remaining, chunkSize - chunkOffset);
        chunk.set(buffer.subarray(offset, offset + amount), chunkOffset);
        offset += amount;
        position += amount;
        remaining -= amount;
      }
      fileSize = Math.max(fileSize, position);
      return length;
    },
    mmap(stream, length, position) {
      var ptr = mmapAlloc(length);
      if (!ptr) throw new FS.ErrnoError(48);
      this.read(stream, HEAP8, ptr, length, position);
      return { ptr, allocated: true };
    },
    msync(stream, buffer, offset, length, mmapFlags) {
      if (!canWrite || (mmapFlags & 2)) return 0;
      this.write(stream, buffer, 0, length, offset);
      return 0;
    }
  });

  Object.defineProperty(node, "usedBytes", {
    configurable: true,
    get() { return fileSize; },
    set(value) { fileSize = value; }
  });
  return node;
}

function v64CreateDiskFile(parent, name, port, initialSize) {
  var node = FS.createFile(parent, name, {}, true, true);
  var fileSize = initialSize;
  var ioSize = 1024 * 1024;
  var controlBuffer = new SharedArrayBuffer(16);
  var control = new Int32Array(controlBuffer);
  var dataBuffer = new SharedArrayBuffer(ioSize);
  var data = new Uint8Array(dataBuffer);
  var originalNodeOps = node.node_ops;

  function request(op, options) {
    Atomics.store(control, 0, 0);
    port.postMessage(Object.assign({
      op,
      control: controlBuffer,
      data: dataBuffer
    }, options));
    Atomics.wait(control, 0, 0);
    if (Atomics.load(control, 0) < 0) throw new FS.ErrnoError(29);
    fileSize = (Atomics.load(control, 2) >>> 0) +
      (Atomics.load(control, 3) >>> 0) * 0x100000000;
    return Atomics.load(control, 1) >>> 0;
  }

  node.node_ops = Object.assign({}, originalNodeOps, {
    setattr(targetNode, attr) {
      for (var key of [ "mode", "atime", "mtime", "ctime" ]) {
        if (attr[key] != null) targetNode[key] = attr[key];
      }
      if (attr.size !== undefined) request("truncate", { size: attr.size });
    }
  });

  node.stream_ops = Object.assign({}, node.stream_ops, {
    read(stream, buffer, offset, length, position) {
      var total = 0;
      while (length > 0) {
        var amount = Math.min(length, ioSize);
        var read = request("read", { position, length: amount });
        if (!read) break;
        buffer.set(data.subarray(0, read), offset);
        total += read;
        offset += read;
        position += read;
        length -= read;
        if (read < amount) break;
      }
      return total;
    },
    write(stream, buffer, offset, length, position) {
      var total = 0;
      while (length > 0) {
        var amount = Math.min(length, ioSize);
        data.set(buffer.subarray(offset, offset + amount), 0);
        var written = request("write", { position, length: amount });
        total += written;
        offset += written;
        position += written;
        length -= written;
        if (written < amount) break;
      }
      return total;
    },
    mmap(stream, length, position) {
      var ptr = mmapAlloc(length);
      if (!ptr) throw new FS.ErrnoError(48);
      this.read(stream, HEAP8, ptr, length, position);
      return { ptr, allocated: true };
    },
    msync(stream, buffer, offset, length, mmapFlags) {
      if (mmapFlags & 2) return 0;
      this.write(stream, buffer, 0, length, offset);
      return 0;
    },
    fsync() {
      request("flush", {});
      return 0;
    }
  });

  Object.defineProperty(node, "usedBytes", {
    configurable: true,
    get() { return fileSize; },
    set(value) { fileSize = value; }
  });
  return node;
}

function v64InitWorkerFS(config) {
  if (!ENVIRONMENT_IS_PTHREAD || !config || Module["v64FSReady"]) return;
  Module["v64FSReady"] = true;
  if (!SOCKFS.root) SOCKFS.root = FS.mount(SOCKFS, {}, null);
  if (!FS.initialized) FS.init();
  TTY.init();
  if (!PIPEFS.root) PIPEFS.root = FS.mount(PIPEFS, {}, null);
  try { FS.mkdir("/v64"); } catch (error) { if (error.errno !== 20) throw error; }
  try { FS.mkdir("/v64/rom"); } catch (error) { if (error.errno !== 20) throw error; }
  for (var rom of config.roms || []) {
    FS.createDataFile("/v64/rom", rom.name, rom.bytes, true, false, true);
  }
  if (config.iso) v64CreateBlobFile("/v64", "installer.iso", config.iso, false);
  if (config.seed) v64CreateBlobFile("/v64", "debian-seed.iso", config.seed, false);
  if (config.diskPort) v64CreateDiskFile("/v64", "disk.img", config.diskPort, config.diskSize || 0);
  for (var rom of config.roms || []) v64Preopen("/v64/rom/" + rom.name, "r");
  if (config.iso) v64Preopen("/v64/installer.iso", "r");
  if (config.seed) v64Preopen("/v64/debian-seed.iso", "r");
  if (config.diskPort) v64Preopen("/v64/disk.img", "r+");
}

if (ENVIRONMENT_IS_PTHREAD) {`,
  "worker filesystem helpers"
);

replaceOnce(
  '      if (cmd === "load") {\n        // Preload command',
  '      if (cmd === "load") {\n        v64WorkerConfig = msgData.v64Config || null;\n        // Preload command',
  "receive VM configuration"
);

replaceOnce(
  '        startWorker = () => {\n          // Notify the main thread',
  '        startWorker = () => {\n          v64InitWorkerFS(v64WorkerConfig);\n          // Notify the main thread',
  "initialize worker filesystem"
);

replaceOnce(
  `    worker.postMessage({
      cmd: "load",
      handlers,
      wasmMemory,
      wasmModule
    });`,
  `    var diskChannel = Module["v64StorageWorker"] ? new MessageChannel() : null;
    if (diskChannel) {
      Module["v64StorageWorker"].postMessage({ cmd: "attach", port: diskChannel.port1 }, [ diskChannel.port1 ]);
    }
    var v64Config = {
      iso: Module["v64ISO"] || null,
      seed: Module["v64Seed"] || null,
      roms: Module["v64Roms"] || [],
      diskSize: Module["v64DiskSize"] || 0,
      diskPort: diskChannel ? diskChannel.port2 : null
    };
    var transfer = diskChannel ? [ diskChannel.port2 ] : [];
    worker.postMessage({
      cmd: "load",
      handlers,
      wasmMemory,
      wasmModule,
      v64Config
    }, transfer);`,
  "send VM configuration"
);

replaceOnce(
  `    path = SYSCALLS.calculateAt(dirfd, path);
    var mode = varargs ? syscallGetVarargI() : 0;
    return FS.open(path, flags, mode).fd;`,
  `    path = SYSCALLS.calculateAt(dirfd, path);
    var v64FD = v64PreopenedFiles[path];
    if (v64FD !== undefined) return v64FD;
    var mode = varargs ? syscallGetVarargI() : 0;
    return FS.open(path, flags, mode).fd;`,
  "reuse deterministic file descriptors"
);

const localFunctions = new Set([
  "___syscall_chdir", "___syscall_chmod", "___syscall_dup3", "___syscall_faccessat",
  "___syscall_fallocate", "___syscall_fchmod", "___syscall_fchownat", "___syscall_fcntl64",
  "___syscall_fstat64", "___syscall_fstatfs64", "___syscall_ftruncate64", "___syscall_getcwd",
  "___syscall_getdents64", "___syscall_ioctl", "___syscall_lstat64", "___syscall_mkdirat",
  "___syscall_newfstatat", "___syscall_openat", "___syscall_pipe", "___syscall_poll",
  "___syscall_readlinkat", "___syscall_renameat", "___syscall_rmdir", "___syscall_stat64",
  "___syscall_statfs64", "___syscall_symlinkat", "___syscall_unlinkat", "___syscall_utimensat",
  "__mmap_js", "__msync_js", "__munmap_js", "_environ_get", "_environ_sizes_get",
  "_fd_close", "_fd_fdstat_get", "_fd_pread", "_fd_pwrite", "_fd_read", "_fd_seek",
  "_fd_sync", "_fd_write"
]);

let removed = 0;
for (const name of localFunctions) {
  let functionStart = source.indexOf(`function ${name}(`);
  if (functionStart < 0) functionStart = source.indexOf(`var ${name} = function(`);
  if (functionStart < 0) throw new Error(`Missing local filesystem function: ${name}`);
  const brace = source.indexOf("{", functionStart);
  const proxyPrefix = "\n  if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread";
  const proxyStart = source.indexOf(proxyPrefix, brace);
  if (proxyStart < 0 || proxyStart - brace > 4) {
    throw new Error(`Missing pthread proxy in ${name}`);
  }
  const proxyEnd = source.indexOf("\n", proxyStart + 1);
  source = source.slice(0, proxyStart) + source.slice(proxyEnd);
  removed++;
}

if (removed !== localFunctions.size) {
  throw new Error(`Expected ${localFunctions.size} local proxies, removed ${removed}`);
}

replaceOnce(
  `function _fd_close(fd) {
  try {
    var stream = SYSCALLS.getStreamFromFD(fd);`,
  `function _fd_close(fd) {
  try {
    if (v64IsPreopenedFD(fd)) return 0;
    var stream = SYSCALLS.getStreamFromFD(fd);`,
  "keep shared virtual files open"
);

if (source === original) throw new Error("Engine wasn't changed");
fs.writeFileSync(target, source);
console.log(`Patched ${target}: ${removed} filesystem proxies moved into VM workers`);
