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

export interface ServiceStorage {
  event<T>(name?: string): EventStorage<T>;
  singleton<T>(name?: string): SingletonStorage<T>;
  kv<T>(name?: string): KeyValueStorage<T>;
}

export interface PeerStorage {
  service(name: string): ServiceStorage;
}

export interface Storage {
  peer(peerId: string): PeerStorage;
}

export function createStorage(): Storage {
  const peers = new Map<string, PeerStorage>();

  return {
    peer(peerId) {
      let storage = peers.get(peerId);
      if (storage === undefined) {
        storage = createPeerStorage();
        peers.set(peerId, storage);
      }
      return storage;
    },
  };
}

function createPeerStorage(): PeerStorage {
  const services = new Map<string, ServiceStorage>();

  return {
    service(name) {
      let storage = services.get(name);
      if (storage === undefined) {
        storage = createServiceStorage();
        services.set(name, storage);
      }
      return storage;
    },
  };
}

function createServiceStorage(): ServiceStorage {
  const eventStores = new Map<string | undefined, EventStorage<unknown>>();
  const singletonStores = new Map<string | undefined, SingletonStorage<unknown>>();
  const keyValueStores = new Map<string | undefined, KeyValueStorage<unknown>>();

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
