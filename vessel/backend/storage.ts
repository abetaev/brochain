import type { Signal, Signals } from "./signals.ts";

export interface EventStorageChange {
  readonly operation: "append";
}

export interface SingletonStorageChange {
  readonly operation: "put" | "clear";
}

export interface KeyValueStorageChange {
  readonly operation: "put" | "delete";
  readonly key: string;
}

export interface EventStorage<T> {
  readonly changes: Signal<EventStorageChange>;
  append(event: T): void;
  read(): readonly T[];
}

export interface SingletonStorage<T> {
  readonly changes: Signal<SingletonStorageChange>;
  get(): T | undefined;
  put(value: T): void;
  clear(): void;
}

export interface KeyValueStorage<T> {
  readonly changes: Signal<KeyValueStorageChange>;
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

export function createStorage(signals: Signals): Storage {
  const peers = new Map<string, PeerStorage>();

  return {
    peer(peerId) {
      let storage = peers.get(peerId);
      if (storage === undefined) {
        storage = createPeerStorage(signals);
        peers.set(peerId, storage);
      }
      return storage;
    },
  };
}

function createPeerStorage(signals: Signals): PeerStorage {
  const services = new Map<string, ServiceStorage>();

  return {
    service(name) {
      let storage = services.get(name);
      if (storage === undefined) {
        storage = createServiceStorage(signals);
        services.set(name, storage);
      }
      return storage;
    },
  };
}

function createServiceStorage(signals: Signals): ServiceStorage {
  const eventStores = new Map<string | undefined, EventStorage<unknown>>();
  const singletonStores = new Map<string | undefined, SingletonStorage<unknown>>();
  const keyValueStores = new Map<string | undefined, KeyValueStorage<unknown>>();

  return {
    event<T>(name?: string) {
      return findStorage(
        eventStores,
        name,
        () => createEventStorage(signals),
      ) as EventStorage<T>;
    },
    singleton<T>(name?: string) {
      return findStorage(
        singletonStores,
        name,
        () => createSingletonStorage(signals),
      ) as SingletonStorage<T>;
    },
    kv<T>(name?: string) {
      return findStorage(
        keyValueStores,
        name,
        () => createKeyValueStorage(signals),
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

function createEventStorage<T>(signals: Signals): EventStorage<T> {
  const events: T[] = [];
  const changes = signals.channel<EventStorageChange>();

  return {
    changes,
    append(event) {
      events.push(event);
      signals.publish(changes, { operation: "append" });
    },
    read: () => Object.freeze([...events]),
  };
}

function createSingletonStorage<T>(signals: Signals): SingletonStorage<T> {
  const changes = signals.channel<SingletonStorageChange>();
  let current: T | undefined;

  return {
    changes,
    get: () => current,
    put(value) {
      current = value;
      signals.publish(changes, { operation: "put" });
    },
    clear() {
      current = undefined;
      signals.publish(changes, { operation: "clear" });
    },
  };
}

function createKeyValueStorage<T>(signals: Signals): KeyValueStorage<T> {
  const values = new Map<string, T>();
  const changes = signals.channel<KeyValueStorageChange>();

  return {
    changes,
    get: (key) => values.get(key),
    put(key, value) {
      values.set(key, value);
      signals.publish(changes, { operation: "put", key });
    },
    delete(key) {
      values.delete(key);
      signals.publish(changes, { operation: "delete", key });
    },
    entries() {
      return Object.freeze(
        [...values].map(([key, value]) => Object.freeze([key, value] as const)),
      );
    },
  };
}
