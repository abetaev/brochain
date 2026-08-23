export interface EventStorage<T> {
  append(event: T): void;
  read(): readonly T[];
}

export interface SingletonStorage<T> {
  get(): T | undefined;
  put(value: T): void;
  clear(): void;
}

export interface KeyValueStorage<T> {
  get(key: string): T | undefined;
  put(key: string, value: T): void;
  delete(key: string): void;
  entries(): readonly (readonly [string, T])[];
}

export interface StoredFile {
  blob(): Promise<Blob>;
  remove(): Promise<void>;
}

export interface FileWriter {
  readonly file: StoredFile;
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason: Error): Promise<void>;
}

export interface FileStorage {
  create(size: number): Promise<FileWriter>;
}

export interface ServiceStorage {
  event<T>(name?: string): EventStorage<T>;
  singleton<T>(name?: string): SingletonStorage<T>;
  kv<T>(name?: string): KeyValueStorage<T>;
  fs(name?: string): FileStorage;
}

export interface PeerStorage {
  service(name: string): ServiceStorage;
}

export interface Storage {
  peer(peerId: string): PeerStorage;
  close(): Promise<void>;
}

export function createStorage(): Storage {
  const peers = new Map<string, PeerStorage>();
  const files = createFileRoot();

  return {
    peer(peerId) {
      let storage = peers.get(peerId);
      if (storage === undefined) {
        storage = createPeerStorage(files);
        peers.set(peerId, storage);
      }
      return storage;
    },
    close: files.close,
  };
}

function createPeerStorage(files: FileRoot): PeerStorage {
  const services = new Map<string, ServiceStorage>();

  return {
    service(name) {
      let storage = services.get(name);
      if (storage === undefined) {
        storage = createServiceStorage(files);
        services.set(name, storage);
      }
      return storage;
    },
  };
}

function createServiceStorage(files: FileRoot): ServiceStorage {
  const eventStores = new Map<string | undefined, EventStorage<unknown>>();
  const singletonStores = new Map<string | undefined, SingletonStorage<unknown>>();
  const keyValueStores = new Map<string | undefined, KeyValueStorage<unknown>>();
  const fileStores = new Map<string | undefined, FileStorage>();

  return {
    event<T>(name?: string) {
      return findStorage(
        eventStores,
        name,
        createEventStorage,
      ) as EventStorage<T>;
    },
    singleton<T>(name?: string) {
      return findStorage(
        singletonStores,
        name,
        createSingletonStorage,
      ) as SingletonStorage<T>;
    },
    kv<T>(name?: string) {
      return findStorage(
        keyValueStores,
        name,
        createKeyValueStorage,
      ) as KeyValueStorage<T>;
    },
    fs(name?: string) {
      return findStorage(fileStores, name, () => ({ create: files.create }));
    },
  };
}

function findStorage<T>(
  stores: Map<string | undefined, T>,
  name: string | undefined,
  create: () => T,
): T {
  let storage = stores.get(name);
  if (storage === undefined) {
    storage = create();
    stores.set(name, storage);
  }
  return storage;
}

function createEventStorage<T>(): EventStorage<T> {
  const events: T[] = [];

  return {
    append(event) {
      events.push(event);
    },
    read: () => Object.freeze([...events]),
  };
}

function createSingletonStorage<T>(): SingletonStorage<T> {
  let current: T | undefined;

  return {
    get: () => current,
    put(value) {
      current = value;
    },
    clear() {
      current = undefined;
    },
  };
}

function createKeyValueStorage<T>(): KeyValueStorage<T> {
  const values = new Map<string, T>();

  return {
    get: (key) => values.get(key),
    put(key, value) {
      values.set(key, value);
    },
    delete(key) {
      values.delete(key);
    },
    entries() {
      return Object.freeze(
        [...values].map(([key, value]) => Object.freeze([key, value] as const)),
      );
    },
  };
}

interface FileRoot extends FileStorage {
  close(): Promise<void>;
}

const applicationDirectory = "brochain";
const sessionsDirectory = "sessions";
const reservedQuotaRatio = 0.1;

function createFileRoot(): FileRoot {
  let initialization: Promise<FileRoot> | undefined;
  let shutdown: Promise<void> | undefined;
  let closed = false;

  function requireOpen(): void {
    if (closed) throw new Error("This Storage is closed.");
  }

  async function access(): Promise<FileRoot> {
    requireOpen();
    const attempt = initialization ??= initializeFileRoot();
    try {
      const files = await attempt;
      requireOpen();
      return files;
    } catch (reason) {
      if (!closed && initialization === attempt) initialization = undefined;
      throw reason;
    }
  }

  return {
    async create(size) {
      validateSize(size);
      return await (await access()).create(size);
    },
    async close() {
      if (shutdown === undefined) {
        closed = true;
        const current = initialization;
        shutdown = current === undefined
          ? Promise.resolve()
          : current.then(async (files) => await files.close());
      }
      await shutdown;
    },
  };
}

async function initializeFileRoot(): Promise<FileRoot> {
  if (
    typeof navigator === "undefined" ||
    navigator.storage?.getDirectory === undefined ||
    navigator.storage.estimate === undefined ||
    navigator.locks === undefined
  ) {
    throw new Error("This browser does not provide private file storage.");
  }

  const root = await navigator.storage.getDirectory();
  const application = await root.getDirectoryHandle(applicationDirectory, { create: true });
  const sessions = await application.getDirectoryHandle(sessionsDirectory, { create: true });
  const sessionId = crypto.randomUUID();
  let releaseLifetime!: () => void;
  const lifetimeReleased = new Promise<void>((resolve) => {
    releaseLifetime = resolve;
  });
  let markAcquired!: () => void;
  const acquired = new Promise<void>((resolve) => {
    markAcquired = resolve;
  });
  const lifetime = navigator.locks.request(lockName(sessionId), async (lock) => {
    if (lock === null) throw new Error("Unable to reserve private file storage.");
    markAcquired();
    await lifetimeReleased;
  });
  await Promise.race([acquired, lifetime]);

  try {
    await removeAbandonedSessions(sessions, sessionId);
    const directory = await sessions.getDirectoryHandle(sessionId, { create: true });
    const creations = new Set<Promise<FileWriter>>();
    const writers = new Set<(reason: Error) => Promise<void>>();
    let reserved = 0;
    let closed = false;
    let shutdown: Promise<void> | undefined;

    function requireOpen(): void {
      if (closed) throw new Error("This Storage file system is closed.");
    }

    async function createWriter(size: number): Promise<FileWriter> {
      const estimate = await navigator.storage.estimate();
      requireOpen();
      const quota = estimate.quota ?? 0;
      const usage = estimate.usage ?? 0;
      const usable = Math.floor(quota * (1 - reservedQuotaRatio));
      if (usage + reserved + size > usable) {
        throw new Error("There is not enough private storage for this data transfer.");
      }

      reserved += size;
      const fileName = crypto.randomUUID();
      try {
        const handle = await directory.getFileHandle(fileName, { create: true });
        const writable = await handle.createWritable({ keepExistingData: false });
        let position = 0;
        let finished = false;
        let removed = false;

        const releaseReservation = () => {
          if (finished) return;
          finished = true;
          reserved -= size;
          writers.delete(abort);
        };
        const remove = async () => {
          if (removed) return;
          removed = true;
          await directory.removeEntry(fileName).catch((reason) => {
            if (!isMissingEntry(reason)) throw reason;
          });
        };
        const abort = async (reason: Error) => {
          if (!finished) {
            await writable.abort(reason).catch(() => {});
            releaseReservation();
          }
          await remove();
        };
        writers.add(abort);

        const file: StoredFile = {
          async blob() {
            if (removed) throw new Error("This stored file is no longer available.");
            return (await handle.getFile()).slice();
          },
          remove,
        };

        return {
          file,
          async write(bytes) {
            if (finished) throw new Error("This file writer is closed.");
            if (!(bytes instanceof Uint8Array)) {
              throw new Error("A file writer accepts only byte arrays.");
            }
            if (position + bytes.byteLength > size) {
              throw new Error("The stored file exceeded its declared size.");
            }
            const copy = new Uint8Array(bytes.byteLength);
            copy.set(bytes);
            await writable.write(copy);
            position += bytes.byteLength;
          },
          async close() {
            if (finished) return;
            if (position !== size) {
              await abort(new Error("The stored file did not reach its declared size."));
              throw new Error("The stored file did not reach its declared size.");
            }
            await writable.close();
            releaseReservation();
          },
          abort,
        } satisfies FileWriter;
      } catch (reason) {
        reserved -= size;
        await directory.removeEntry(fileName).catch(() => {});
        throw reason;
      }
    }

    return {
      create(size) {
        requireOpen();
        const creation = createWriter(size);
        creations.add(creation);
        void creation.finally(() => creations.delete(creation)).catch(() => {});
        return creation;
      },
      async close() {
        if (shutdown === undefined) {
          closed = true;
          shutdown = (async () => {
            try {
              await Promise.allSettled([...creations]);
              const reason = new Error("This Storage file system was closed.");
              await Promise.allSettled([...writers].map(async (abort) => await abort(reason)));
              await sessions.removeEntry(sessionId, { recursive: true }).catch((error) => {
                if (!isMissingEntry(error)) throw error;
              });
            } finally {
              releaseLifetime();
              await lifetime;
            }
          })();
        }
        await shutdown;
      },
    };
  } catch (reason) {
    releaseLifetime();
    await lifetime.catch(() => {});
    throw reason;
  }
}

async function removeAbandonedSessions(
  sessions: FileSystemDirectoryHandle,
  current: string,
): Promise<void> {
  for await (const name of sessions.keys()) {
    if (name === current) continue;
    await navigator.locks.request(lockName(name), { ifAvailable: true }, async (lock) => {
      if (lock === null) return;
      await sessions.removeEntry(name, { recursive: true }).catch((reason) => {
        if (!isMissingEntry(reason)) throw reason;
      });
    });
  }
}

function lockName(sessionId: string): string {
  return `brochain-session-data:${sessionId}`;
}

function validateSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("Stored files must have a non-negative safe size.");
  }
}

function isMissingEntry(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "NotFoundError";
}
