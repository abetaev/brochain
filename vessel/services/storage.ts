export interface EventStorage<T> {
  append(event: T): void;
  read(): readonly T[];
  subscribe(listener: (event: T) => void): () => void;
}

export interface SingletonStorage<T> {
  get(): T | undefined;
  put(value: T): void;
  clear(): void;
  subscribe(listener: (value: T | undefined) => void): () => void;
}

export interface KeyValueStorage<T> {
  get(key: string): T | undefined;
  put(key: string, value: T): void;
  delete(key: string): void;
  entries(): readonly (readonly [string, T])[];
  subscribe(listener: (key: string, value: T | undefined) => void): () => void;
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
  const listeners = new Set<(event: T) => void>();

  return {
    append(event) {
      events.push(event);
      for (const listener of listeners) listener(event);
    },
    read: () => Object.freeze([...events]),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function createSingletonStorage<T>(): SingletonStorage<T> {
  const listeners = new Set<(value: T | undefined) => void>();
  let current: T | undefined;

  function publish(): void {
    for (const listener of listeners) listener(current);
  }

  return {
    get: () => current,
    put(value) {
      current = value;
      publish();
    },
    clear() {
      current = undefined;
      publish();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function createKeyValueStorage<T>(): KeyValueStorage<T> {
  const values = new Map<string, T>();
  const listeners = new Set<(key: string, value: T | undefined) => void>();

  function publish(key: string, value: T | undefined): void {
    for (const listener of listeners) listener(key, value);
  }

  return {
    get: (key) => values.get(key),
    put(key, value) {
      values.set(key, value);
      publish(key, value);
    },
    delete(key) {
      values.delete(key);
      publish(key, undefined);
    },
    entries() {
      return Object.freeze(
        [...values].map(([key, value]) => Object.freeze([key, value] as const)),
      );
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
