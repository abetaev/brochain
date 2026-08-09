interface EventStorage<T> {
  append(event: T): void;
  read(): readonly T[];
  subscribe(listener: (event: T) => void): () => void;
}

interface ValueStorage<T> {
  get(): T | undefined;
  put(value: T): void;
  subscribe(listener: (value: T) => void): () => void;
}

export interface StorageFactory {
  events<T>(
    peerId: string,
    serviceName: string,
    storageName?: string,
  ): EventStorage<T>;
  value<T>(
    peerId: string,
    serviceName: string,
    storageName?: string,
  ): ValueStorage<T>;
}

export function createStorage(): StorageFactory {
  const eventStores = new Map<
    string,
    Map<string, Map<string | undefined, EventStorage<unknown>>>
  >();
  const valueStores = new Map<
    string,
    Map<string, Map<string | undefined, ValueStorage<unknown>>>
  >();

  return {
    events<T>(peerId: string, serviceName: string, storageName?: string) {
      return findStorage(
        eventStores,
        peerId,
        serviceName,
        storageName,
        createEventStorage,
      ) as EventStorage<T>;
    },
    value<T>(peerId: string, serviceName: string, storageName?: string) {
      return findStorage(
        valueStores,
        peerId,
        serviceName,
        storageName,
        createValueStorage,
      ) as ValueStorage<T>;
    },
  };
}

function findStorage<T>(
  stores: Map<string, Map<string, Map<string | undefined, T>>>,
  peerId: string,
  serviceName: string,
  storageName: string | undefined,
  create: () => T,
): T {
  let peerStores = stores.get(peerId);
  if (peerStores === undefined) {
    peerStores = new Map();
    stores.set(peerId, peerStores);
  }

  let serviceStores = peerStores.get(serviceName);
  if (serviceStores === undefined) {
    serviceStores = new Map();
    peerStores.set(serviceName, serviceStores);
  }

  let storage = serviceStores.get(storageName);
  if (storage === undefined) {
    storage = create();
    serviceStores.set(storageName, storage);
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

function createValueStorage<T>(): ValueStorage<T> {
  const listeners = new Set<(value: T) => void>();
  let current: T | undefined;

  return {
    get: () => current,
    put(value) {
      current = value;
      for (const listener of listeners) listener(value);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
