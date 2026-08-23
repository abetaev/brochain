// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorage } from "./storage.ts";

describe("Session Storage", () => {
  it("returns stable scopes for each peer identity and service", () => {
    const storage = createStorage();
    const peer = storage.peer("peer");
    const service = peer.service("messaging");

    expect(storage.peer("peer")).toBe(peer);
    expect(peer.service("messaging")).toBe(service);
    expect(storage.peer("other-peer")).not.toBe(peer);
    expect(peer.service("identity")).not.toBe(service);
  });

  it("returns stable and independent default and named file stores", () => {
    const storage = createStorage();
    const service = storage.peer("peer").service("chat");
    const files = service.fs();

    expect(service.fs()).toBe(files);
    expect(service.fs("")).not.toBe(files);
    expect(storage.peer("peer").service("other").fs()).not.toBe(files);
    expect(storage.peer("other-peer").service("chat").fs()).not.toBe(files);
  });

  it("retains events and returns immutable snapshots", () => {
    const storage = createStorage();
    const events = storage.peer("peer").service("messaging").event<string>();

    events.append("first");
    const snapshot = events.read();
    events.append("second");

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).toEqual(["first"]);
    expect(events.read()).toEqual(["first", "second"]);
  });

  it("stores and clears singleton values", () => {
    const storage = createStorage();
    const value = storage.peer("peer").service("identity").singleton<string>();

    expect(value.get()).toBeUndefined();
    value.put("current");
    expect(value.get()).toBe("current");
    value.clear();
    expect(value.get()).toBeUndefined();
  });

  it("stores and deletes key/value entries while returning immutable snapshots", () => {
    const storage = createStorage();
    const values = storage.peer("peer").service("contacts").kv<number>();

    values.put("ada", 1);
    values.put("bob", 2);
    const snapshot = values.entries();
    values.delete("ada");
    values.put("ignored", 3);

    expect(values.get("ada")).toBeUndefined();
    expect(values.get("bob")).toBe(2);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.every(Object.isFrozen)).toBe(true);
    expect(snapshot).toEqual([["ada", 1], ["bob", 2]]);
    expect(values.entries()).toEqual([["bob", 2], ["ignored", 3]]);
  });

  it("keeps storage kinds, default names, and named stores independent", () => {
    const storage = createStorage();
    const service = storage.peer("peer").service("service");
    const events = service.event<string>();
    const namedEvents = service.event<string>("");
    const singleton = service.singleton<string>();
    const keyValues = service.kv<string>();

    events.append("event");
    namedEvents.append("named");
    singleton.put("singleton");
    keyValues.put("key", "value");

    expect(service.event<string>()).toBe(events);
    expect(service.event<string>("")).toBe(namedEvents);
    expect(service.singleton<string>()).toBe(singleton);
    expect(service.kv<string>()).toBe(keyValues);
    expect(events.read()).toEqual(["event"]);
    expect(namedEvents.read()).toEqual(["named"]);
    expect(singleton.get()).toBe("singleton");
    expect(keyValues.entries()).toEqual([["key", "value"]]);
  });

  it("isolates peer, service, and Session scopes", () => {
    const first = createStorage();
    const second = createStorage();
    const events = first.peer("peer").service("messaging").event<string>();

    events.append("first Session only");

    expect(first.peer("other").service("messaging").event().read()).toEqual([]);
    expect(first.peer("peer").service("other").event().read()).toEqual([]);
    expect(second.peer("peer").service("messaging").event().read()).toEqual([]);
  });

  it("does not require browser file storage for structured values or unused shutdown", async () => {
    const storage = createStorage();
    storage.peer("peer").service("identity").singleton<string>().put("name");

    expect(storage.peer("peer").service("identity").singleton<string>().get())
      .toBe("name");
    await expect(storage.close()).resolves.toBeUndefined();
  });
});

interface DirectoryNode {
  readonly directories: Map<string, DirectoryNode>;
  readonly files: Map<string, FileNode>;
}

interface FileNode {
  contents: Uint8Array;
  removed: boolean;
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
        file = { contents: new Uint8Array(), removed: false };
        node.files.set(name, file);
      }
      return fileHandle(name, file);
    },
    async removeEntry(name: string, options?: FileSystemRemoveOptions) {
      const file = node.files.get(name);
      if (file !== undefined) {
        file.removed = true;
        node.files.delete(name);
        return;
      }
      const directory = node.directories.get(name);
      if (directory === undefined) throw missing();
      if (
        options?.recursive !== true &&
        (directory.files.size > 0 || directory.directories.size > 0)
      ) {
        throw new DOMException("Directory is not empty.", "InvalidModificationError");
      }
      markRemoved(directory);
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
      if (node.removed) throw missing();
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

function markRemoved(directory: DirectoryNode): void {
  for (const file of directory.files.values()) file.removed = true;
  for (const child of directory.directories.values()) markRemoved(child);
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
let getDirectory: ReturnType<typeof vi.fn>;

describe("Session file Storage", () => {
  beforeEach(() => {
    root = directoryNode();
    quota = 100;
    usage = 0;
    getDirectory = vi.fn(async () => directoryHandle(root));
    vi.stubGlobal("navigator", {
      storage: {
        getDirectory,
        estimate: async () => ({ quota, usage }),
      },
      locks: testLocks(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps structured stores usable when private file storage is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    const storage = createStorage();
    const service = storage.peer("peer").service("chat");
    service.singleton<string>().put("available");

    expect(service.singleton<string>().get()).toBe("available");
    await expect(service.fs().create(0)).rejects
      .toThrow("browser does not provide private file storage");
    await storage.close();
  });

  it("writes exact bytes and exposes an opaque Blob", async () => {
    const storage = createStorage();
    const writer = await storage.peer("peer").service("chat").fs().create(4);

    await writer.write(new Uint8Array([1, 2]));
    await writer.write(new Uint8Array([3, 4]));
    await writer.close();

    const blob = await writer.file.blob();
    expect(blob).toBeInstanceOf(Blob);
    expect(blob).not.toBeInstanceOf(File);
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    await storage.close();
  });

  it("supports empty files and idempotent close and removal", async () => {
    const storage = createStorage();
    const writer = await storage.peer("peer").service("chat").fs().create(0);

    await writer.close();
    await writer.close();
    expect((await writer.file.blob()).size).toBe(0);
    await writer.file.remove();
    await writer.file.remove();
    await expect(writer.file.blob()).rejects.toThrow("no longer available");
    await storage.close();
    await storage.close();
  });

  it("validates sizes, byte writes, and exact declared length", async () => {
    const storage = createStorage();
    const files = storage.peer("peer").service("chat").fs();

    await expect(files.create(-1)).rejects.toThrow("non-negative safe size");
    await expect(files.create(1.5)).rejects.toThrow("non-negative safe size");
    await expect(files.create(Number.MAX_VALUE)).rejects.toThrow("non-negative safe size");

    const invalidBytes = await files.create(1);
    await expect(invalidBytes.write("x" as unknown as Uint8Array))
      .rejects.toThrow("only byte arrays");
    await invalidBytes.abort(new Error("invalid"));
    await invalidBytes.abort(new Error("already aborted"));
    await invalidBytes.close();

    const excessive = await files.create(1);
    await expect(excessive.write(new Uint8Array([1, 2])))
      .rejects.toThrow("exceeded its declared size");
    await excessive.abort(new Error("excessive"));

    const incomplete = await files.create(2);
    await incomplete.write(new Uint8Array([1]));
    await expect(incomplete.close()).rejects.toThrow("did not reach its declared size");
    await expect(incomplete.file.blob()).rejects.toThrow("no longer available");
    await storage.close();
  });

  it("shares quota reservations across peer and service file stores", async () => {
    usage = 20;
    const storage = createStorage();
    const first = storage.peer("first").service("chat").fs();
    const second = storage.peer("second").service("other").fs("files");
    const writer = await first.create(40);

    await expect(second.create(31)).rejects.toThrow("not enough private storage");
    await expect(first.create(70)).rejects.toThrow("not enough private storage");

    await writer.abort(new Error("cancelled"));
    const afterAbort = await second.create(70);
    await afterAbort.abort(new Error("finished quota check"));

    const completed = await first.create(40);
    await completed.write(new Uint8Array(40));
    await completed.close();
    usage = 60;
    await expect(second.create(30)).resolves.toBeDefined();
    await storage.close();
  });

  it("deletes partial and abandoned Session files", async () => {
    const application = directoryNode();
    const sessions = directoryNode();
    sessions.directories.set("abandoned", directoryNode());
    application.directories.set("sessions", sessions);
    root.directories.set("brochain", application);

    const storage = createStorage();
    expect(sessions.directories.has("abandoned")).toBe(true);
    const writer = await storage.peer("peer").service("chat").fs().create(2);
    expect(sessions.directories.has("abandoned")).toBe(false);
    await writer.write(new Uint8Array([1]));
    await expect(writer.close()).rejects.toThrow("did not reach its declared size");
    expect([...sessions.directories.values()].flatMap((directory) => [...directory.files]))
      .toEqual([]);

    await storage.close();
    expect(sessions.directories.size).toBe(0);
  });

  it("does not remove another active Storage Session", async () => {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000003")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000004");
    const first = createStorage();
    const firstWriter = await first.peer("peer").service("chat").fs().create(0);
    await firstWriter.close();
    const sessions = root.directories.get("brochain")?.directories.get("sessions");

    const second = createStorage();
    const secondWriter = await second.peer("peer").service("chat").fs().create(0);
    await secondWriter.close();

    expect(sessions?.directories.has("00000000-0000-4000-8000-000000000001")).toBe(true);
    expect(sessions?.directories.has("00000000-0000-4000-8000-000000000003")).toBe(true);
    await second.close();
    await first.close();
  });

  it("retries lazy initialization after failure", async () => {
    getDirectory
      .mockRejectedValueOnce(new Error("OPFS temporarily failed."))
      .mockResolvedValue(directoryHandle(root));
    const storage = createStorage();
    const files = storage.peer("peer").service("chat").fs();

    await expect(files.create(0)).rejects.toThrow("temporarily failed");
    const writer = await files.create(0);
    await writer.close();

    expect(getDirectory).toHaveBeenCalledTimes(2);
    await storage.close();
  });

  it("waits for pending initialization before closing and rejects its creation", async () => {
    let finishRoot: ((root: FileSystemDirectoryHandle) => void) | undefined;
    getDirectory.mockImplementationOnce(async () =>
      await new Promise<FileSystemDirectoryHandle>((resolve) => {
        finishRoot = resolve;
      })
    );
    const storage = createStorage();
    const creation = storage.peer("peer").service("chat").fs().create(1);
    await vi.waitFor(() => expect(finishRoot).toBeDefined());

    const closing = storage.close();
    finishRoot?.(directoryHandle(root));

    await expect(creation).rejects.toThrow("Storage is closed");
    await expect(closing).resolves.toBeUndefined();
    expect(root.directories.get("brochain")?.directories.get("sessions")?.directories.size)
      .toBe(0);
    await expect(storage.peer("peer").service("chat").fs().create(0))
      .rejects.toThrow("Storage is closed");
  });

  it("aborts active writers and deletes completed files on shutdown", async () => {
    const storage = createStorage();
    const files = storage.peer("peer").service("chat").fs();
    const partial = await files.create(2);
    await partial.write(new Uint8Array([1]));
    const complete = await files.create(1);
    await complete.write(new Uint8Array([2]));
    await complete.close();

    await storage.close();

    await expect(partial.file.blob()).rejects.toThrow();
    await expect(complete.file.blob()).rejects.toThrow();
    await expect(files.create(0)).rejects.toThrow("Storage is closed");
  });
});
