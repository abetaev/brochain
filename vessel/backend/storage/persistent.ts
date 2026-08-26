import type {
  PersistentKeyValueStorage,
  PersistentPeerStorage,
  PersistentServiceStorage,
  PersistentStorage,
} from "./index";

export interface PersistentRoot extends PersistentStorage {
  close(): Promise<void>;
}

interface PersistentValue<T = unknown> {
  readonly peerId: string;
  readonly serviceName: string;
  readonly kind: "kv";
  readonly named: 0 | 1;
  readonly storeName: string;
  readonly key: string;
  readonly value: T;
}

const valuesStoreName = "values";
const valuesScopeIndex = "scope";

interface PersistentScope {
  readonly peerId: string;
  readonly serviceName: string;
  readonly named: 0 | 1;
  readonly storeName: string;
}

export async function createPersistentRoot(
  databaseName: string,
): Promise<PersistentRoot> {
  const database = await openPersistentStorage(databaseName);
  const peers = new Map<string, PersistentPeerStorage>();
  const operations = new Set<Promise<unknown>>();
  let shutdown: Promise<void> | undefined;

  function operate<T>(operation: (database: IDBDatabase) => Promise<T>): Promise<T> {
    const pending = operation(database);
    operations.add(pending);
    void pending.finally(() => operations.delete(pending)).catch(() => {});
    return pending;
  }

  return {
    peer(peerId) {
      let peer = peers.get(peerId);
      if (peer === undefined) {
        peer = createPersistentPeerStorage(peerId, operate);
        peers.set(peerId, peer);
      }
      return peer;
    },
    async close() {
      if (shutdown === undefined) {
        shutdown = (async () => {
          await Promise.allSettled([...operations]);
          database.close();
        })();
      }
      await shutdown;
    },
  };
}

function createPersistentPeerStorage(
  peerId: string,
  operate: <T>(operation: (database: IDBDatabase) => Promise<T>) => Promise<T>,
): PersistentPeerStorage {
  const services = new Map<string, PersistentServiceStorage>();

  return {
    service(serviceName) {
      let service = services.get(serviceName);
      if (service === undefined) {
        service = createPersistentServiceStorage(
          peerId,
          serviceName,
          operate,
        );
        services.set(serviceName, service);
      }
      return service;
    },
  };
}

function createPersistentServiceStorage(
  peerId: string,
  serviceName: string,
  operate: <T>(operation: (database: IDBDatabase) => Promise<T>) => Promise<T>,
): PersistentServiceStorage {
  const stores = new Map<string | undefined, PersistentKeyValueStorage<unknown>>();

  return {
    kv<T>(name?: string) {
      let storage = stores.get(name);
      if (storage === undefined) {
        storage = createPersistentKeyValueStorage(
          {
            peerId,
            serviceName,
            named: name === undefined ? 0 : 1,
            storeName: name ?? "",
          },
          operate,
        );
        stores.set(name, storage);
      }
      return storage as PersistentKeyValueStorage<T>;
    },
  };
}

function createPersistentKeyValueStorage<T>(
  scope: PersistentScope,
  operate: <Result>(
    operation: (database: IDBDatabase) => Promise<Result>,
  ) => Promise<Result>,
): PersistentKeyValueStorage<T> {
  const primaryKey = (key: string) => [
    scope.peerId,
    scope.serviceName,
    "kv",
    scope.named,
    scope.storeName,
    key,
  ];
  const scopeKey = [
    scope.peerId,
    scope.serviceName,
    "kv",
    scope.named,
    scope.storeName,
  ];

  return {
    get: async (key) => await operate(async (database) => await transaction(
      database,
      "readonly",
      async (values) => {
        const result = await requestResult<PersistentValue<T> | undefined>(
          values.get(primaryKey(key)),
        );
        return result?.value;
      },
    )),
    put: async (key, value) => await operate(async (database) => await transaction(
      database,
      "readwrite",
      async (values) => {
        await requestResult(values.put({
          ...scope,
          kind: "kv",
          key,
          value,
        } satisfies PersistentValue<T>));
      },
    )),
    delete: async (key) => await operate(async (database) => await transaction(
      database,
      "readwrite",
      async (values) => {
        await requestResult(values.delete(primaryKey(key)));
      },
    )),
    entries: async () => await operate(async (database) => await transaction(
      database,
      "readonly",
      async (values) => {
        const records = await requestResult<PersistentValue<T>[]>(
          values.index(valuesScopeIndex).getAll(
            IDBKeyRange.only(scopeKey),
          ),
        );
        return Object.freeze(records.map(({ key, value }) =>
          Object.freeze([key, value] as const),
        ));
      },
    )),
  };
}

async function transaction<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (values: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const current = database.transaction(valuesStoreName, mode);
  const completion = transactionResult(current);

  try {
    const result = await operation(current.objectStore(valuesStoreName));
    await completion;
    return result;
  } catch (reason) {
    try {
      current.abort();
    } catch {
      // The transaction may already have completed or aborted.
    }
    await completion.catch(() => undefined);
    throw reason;
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error ?? new Error("IndexedDB request failed."),
    );
  });
}

function transactionResult(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(
      transaction.error ?? new Error("IndexedDB transaction failed."),
    );
    transaction.onabort = () => reject(
      transaction.error ?? new Error("IndexedDB transaction aborted."),
    );
  });
}

function openPersistentStorage(
  databaseName: string,
): Promise<IDBDatabase> {
  if (globalThis.indexedDB === undefined) {
    return Promise.reject(new Error("This browser does not support IndexedDB."));
  }

  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(databaseName, 1);

    request.onupgradeneeded = () => {
      const values = request.result.createObjectStore(valuesStoreName, {
        keyPath: [
          "peerId",
          "serviceName",
          "kind",
          "named",
          "storeName",
          "key",
        ],
      });
      values.createIndex(valuesScopeIndex, [
        "peerId",
        "serviceName",
        "kind",
        "named",
        "storeName",
      ]);
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(
      request.error ?? new Error("Unable to open persistent Storage."),
    );
  });
}
