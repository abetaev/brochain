import { createFileRoot, type FileRoot } from "./file";
import { createPersistentRoot } from "./persistent";

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

export interface VolatileStorage {
  peer(peerId: string): PeerStorage;
  close(): Promise<void>;
}

export interface PersistentKeyValueStorage<T> {
  get(key: string): Promise<T | undefined>;
  put(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  entries(): Promise<readonly (readonly [string, T])[]>;
}

export interface PersistentServiceStorage {
  kv<T>(name?: string): PersistentKeyValueStorage<T>;
}

export interface PersistentPeerStorage {
  service(name: string): PersistentServiceStorage;
}

export interface PersistentStorage {
  peer(peerId: string): PersistentPeerStorage;
}

export interface Storage extends VolatileStorage {
  readonly persistent: PersistentStorage;
}

export function createStorage(
  username: string,
  applicationDatabaseName = "brochain",
): Storage {
  const peers = new Map<string, PeerStorage>();
  const files = createFileRoot();
  const persistent = createPersistentRoot(`${applicationDatabaseName}/${username}`);
  let shutdown: Promise<void> | undefined;

  return {
    persistent,
    peer(peerId) {
      let storage = peers.get(peerId);
      if (storage === undefined) {
        storage = createPeerStorage(files);
        peers.set(peerId, storage);
      }
      return storage;
    },
    async close() {
      if (shutdown === undefined) {
        shutdown = (async () => {
          const results = await Promise.allSettled([
            files.close(),
            persistent.close(),
          ]);
          const failure = results.find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
          if (failure !== undefined) throw failure.reason;
        })();
      }
      await shutdown;
    },
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
      return findStorage(eventStores, name, createEventStorage) as EventStorage<T>;
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
