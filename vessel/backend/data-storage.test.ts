// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDataStorage } from "./data-storage.ts";

interface DirectoryNode {
  readonly directories: Map<string, DirectoryNode>;
  readonly files: Map<string, FileNode>;
}

interface FileNode {
  contents: Uint8Array;
}

function directoryNode(): DirectoryNode {
  return { directories: new Map(), files: new Map() };
}

function directoryHandle(node: DirectoryNode): FileSystemDirectoryHandle {
  return {
    kind: "directory",
    name: "directory",
    isSameEntry: vi.fn(async () => false),
    resolve: vi.fn(async () => null),
    async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions) {
      let child = node.directories.get(name);
      if (child === undefined) {
        if (options?.create !== true) throw missing();
        child = directoryNode();
        node.directories.set(name, child);
      }
      return directoryHandle(child);
    },
    async getFileHandle(name: string, options?: FileSystemGetFileOptions) {
      let file = node.files.get(name);
      if (file === undefined) {
        if (options?.create !== true) throw missing();
        file = { contents: new Uint8Array() };
        node.files.set(name, file);
      }
      return fileHandle(name, file);
    },
    async removeEntry(name: string, options?: FileSystemRemoveOptions) {
      if (node.files.delete(name)) return;
      const directory = node.directories.get(name);
      if (directory === undefined) throw missing();
      if (
        options?.recursive !== true &&
        (directory.files.size > 0 || directory.directories.size > 0)
      ) {
        throw new DOMException("Directory is not empty.", "InvalidModificationError");
      }
      node.directories.delete(name);
    },
    async *keys() {
      yield* node.directories.keys();
      yield* node.files.keys();
    },
  } as unknown as FileSystemDirectoryHandle;
}

function fileHandle(name: string, node: FileNode): FileSystemFileHandle {
  return {
    kind: "file",
    name,
    isSameEntry: vi.fn(async () => false),
    async getFile() {
      const copy = new Uint8Array(node.contents.byteLength);
      copy.set(node.contents);
      return new File([copy], name);
    },
    async createWritable() {
      let contents = new Uint8Array();
      return {
        locked: false,
        abort: vi.fn(async () => {}),
        close: vi.fn(async () => {
          node.contents = contents;
        }),
        write: vi.fn(async (chunk: FileSystemWriteChunkType) => {
          if (!(chunk instanceof Uint8Array)) throw new Error("Unexpected test write.");
          const combined = new Uint8Array(contents.byteLength + chunk.byteLength);
          combined.set(contents);
          combined.set(chunk, contents.byteLength);
          contents = combined;
        }),
        seek: vi.fn(async () => {}),
        truncate: vi.fn(async () => {}),
        getWriter: vi.fn(),
      } as unknown as FileSystemWritableFileStream;
    },
  } as unknown as FileSystemFileHandle;
}

function missing(): DOMException {
  return new DOMException("Entry was not found.", "NotFoundError");
}

function testLocks(): LockManager {
  const held = new Set<string>();
  return {
    query: vi.fn(),
    request: vi.fn(async (
      name: string,
      optionsOrCallback: LockOptions | ((lock: Lock | null) => unknown),
      optionalCallback?: (lock: Lock | null) => unknown,
    ) => {
      const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
      const callback = typeof optionsOrCallback === "function"
        ? optionsOrCallback
        : optionalCallback!;
      if (options.ifAvailable === true && held.has(name)) return await callback(null);
      held.add(name);
      try {
        return await callback({ name, mode: options.mode ?? "exclusive" });
      } finally {
        held.delete(name);
      }
    }),
  } as unknown as LockManager;
}

let root: DirectoryNode;
let quota = 100;
let usage = 0;

beforeEach(() => {
  root = directoryNode();
  quota = 100;
  usage = 0;
  vi.stubGlobal("navigator", {
    storage: {
      getDirectory: async () => directoryHandle(root),
      estimate: async () => ({ quota, usage }),
    },
    locks: testLocks(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Session data storage", () => {
  it("writes exact data and exposes it as a named File", async () => {
    const storage = await createDataStorage();
    const writer = await storage.create(4);

    await writer.write(new Uint8Array([1, 2]));
    await writer.write(new Uint8Array([3, 4]));
    await writer.close();

    const file = await writer.data.file("payload.bin", "application/octet-stream");
    expect(file.name).toBe("payload.bin");
    expect(file.type).toBe("application/octet-stream");
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    await storage.close();
  });

  it("reserves quota headroom and accounts for concurrent writers", async () => {
    usage = 20;
    const storage = await createDataStorage();
    const writer = await storage.create(40);

    await expect(storage.create(31)).rejects.toThrow("not enough private storage");
    await expect(storage.create(70)).rejects.toThrow("not enough private storage");

    await writer.abort(new Error("cancelled"));
    await expect(storage.create(70)).resolves.toBeDefined();
    await storage.close();
  });

  it("deletes partial and abandoned Session data", async () => {
    const application = directoryNode();
    const sessions = directoryNode();
    sessions.directories.set("abandoned", directoryNode());
    application.directories.set("sessions", sessions);
    root.directories.set("brochain", application);

    const storage = await createDataStorage();
    expect(sessions.directories.has("abandoned")).toBe(false);
    const writer = await storage.create(2);
    await writer.write(new Uint8Array([1]));
    await expect(writer.close()).rejects.toThrow("did not reach its declared size");
    expect([...sessions.directories.values()].flatMap((directory) => [...directory.files]))
      .toEqual([]);

    await storage.close();
    expect(sessions.directories.size).toBe(0);
  });
});
