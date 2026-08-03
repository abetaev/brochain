import type { AccountRepository, StoredAccount } from "./types";

const STORE_NAME = "accounts";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionResult(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
  });
}

function openDatabase(databaseName: string): Promise<IDBDatabase> {
  if (globalThis.indexedDB === undefined) {
    return Promise.reject(new Error("This browser does not support IndexedDB."));
  }

  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(databaseName, 1);

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open account storage."));
  });
}

export function createIndexedDbAccountRepository(databaseName = "brochain"): AccountRepository {
  return {
    async list() {
      const database = await openDatabase(databaseName);

      try {
        const transaction = database.transaction(STORE_NAME, "readonly");
        const accounts = await requestResult(transaction.objectStore(STORE_NAME).getAll());
        return accounts.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      } finally {
        database.close();
      }
    },

    async get(id) {
      const database = await openDatabase(databaseName);

      try {
        const transaction = database.transaction(STORE_NAME, "readonly");
        return await requestResult(transaction.objectStore(STORE_NAME).get(id));
      } finally {
        database.close();
      }
    },

    async put(account) {
      const database = await openDatabase(databaseName);

      try {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        await requestResult(transaction.objectStore(STORE_NAME).put(account));
        await transactionResult(transaction);
      } finally {
        database.close();
      }
    },

    async delete(id) {
      const database = await openDatabase(databaseName);

      try {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        await requestResult(transaction.objectStore(STORE_NAME).delete(id));
        await transactionResult(transaction);
      } finally {
        database.close();
      }
    },
  };
}
