import { expose, type Endpoint } from "comlink";
import { base64ToBytes, bytesToBase64 } from "@c/base64";

interface PeerIdentity {
  username: string;
  version: 1;
  identitySeed: string;
}

export interface SessionAccess {
  activePeerIdentity(): Promise<PeerIdentity | undefined>;
  closeSession(): Promise<void>;
}

interface AccountSecrets {
  version: 1;
  identitySeed: string;
}

interface EncryptedAccountData {
  version: 1;
  kdf: {
    name: "PBKDF2";
    hash: "SHA-256";
    iterations: number;
    salt: string;
  };
  cipher: {
    name: "AES-GCM";
    iv: string;
    ciphertext: string;
  };
}

interface StoredAccount {
  version: 2;
  username: string;
  createdAt: string;
  encryptedData: EncryptedAccountData;
}

const DATABASE_NAME = "brochain-v2";
const STORE_NAME = "accounts";
const KDF_ITERATIONS = 310_000;
const usernamePattern = /^[a-z]{1,64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const incorrectPassword = new Error("The password is incorrect.");

export function createAccountService(databaseName = DATABASE_NAME) {
  let active: PeerIdentity | undefined;
  let sessionOpened = false;
  let mutations = Promise.resolve();
  const storage = openAccountStorage(databaseName);

  function mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutations.then(operation);
    mutations = result.then(() => undefined, () => undefined);
    return result;
  }

  async function read<T>(operation: (accounts: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const transaction = (await storage).transaction(STORE_NAME);
    return await requestResult(operation(transaction.objectStore(STORE_NAME)));
  }

  async function write(operation: (accounts: IDBObjectStore) => IDBRequest): Promise<void> {
    const transaction = (await storage).transaction(STORE_NAME, "readwrite");
    await requestResult(operation(transaction.objectStore(STORE_NAME)));
    await transactionResult(transaction);
  }

  async function get(username: string): Promise<StoredAccount | undefined> {
    return await read((accounts) => accounts.get(username));
  }

  async function list(): Promise<string[]> {
    const accounts = await read((storage) => storage.getAll());
    return accounts
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((account) => account.username);
  }

  async function create(username: string, password: string) {
    assertUsername(username);
    assertPassword(password);
    const secrets = createAccountSecrets();
    const account: StoredAccount = {
      version: 2,
      username,
      createdAt: new Date().toISOString(),
      encryptedData: await encryptAccountSecrets(secrets, password),
    };

    try {
      await write((storage) => storage.add(account));
    } catch (reason) {
      if (isDuplicateKeyError(reason)) {
        throw new Error("That username is already used by this application.");
      }

      throw reason;
    }

    active = { username, ...secrets };
  }

  async function unlock(username: string, password: string) {
    assertUsername(username);
    assertPassword(password);
    const account = await get(username);

    if (account === undefined) {
      throw new Error("The account is no longer stored by this application.");
    }

    const secrets = await decryptAccountSecrets(account.encryptedData, password);
    active = { username: account.username, ...secrets };
  }

  async function deleteAccount(username: string, password: string): Promise<boolean> {
    assertUsername(username);
    assertPassword(password);
    const account = await get(username);

    if (account === undefined) {
      return false;
    }

    try {
      await decryptAccountSecrets(account.encryptedData, password);
    } catch (reason) {
      if (reason === incorrectPassword) {
        return false;
      }

      throw reason;
    }

    await write((storage) => storage.delete(username));

    if (active?.username === username) {
      active = undefined;
    }

    return true;
  }

  async function exportAccount(username: string): Promise<string> {
    assertUsername(username);
    const account = await get(username);

    if (account === undefined) {
      throw new Error("The account is no longer stored by this application.");
    }

    return JSON.stringify(account, null, 2);
  }

  function openSession(port: Endpoint): void {
    if (sessionOpened) throw new Error("Account Session access is already open.");
    sessionOpened = true;
    expose(
      {
        activePeerIdentity: async () => {
          await mutations;
          return active === undefined ? undefined : { ...active };
        },
        closeSession: async () => {
          await mutate(async () => {
            active = undefined;
          });
        },
      } satisfies SessionAccess,
      port,
    );
  }

  return {
    list,
    create: (username: string, password: string) =>
      mutate(async () => await create(username, password)),
    unlock: (username: string, password: string) =>
      mutate(async () => await unlock(username, password)),
    delete: (username: string, password: string) =>
      mutate(async () => await deleteAccount(username, password)),
    export: exportAccount,
    openSession,
  };
}

export type AccountService = ReturnType<typeof createAccountService>;

function assertUsername(username: string): void {
  if (!usernamePattern.test(username)) {
    throw new Error("Username must contain 1 to 64 lowercase letters.");
  }
}

function assertPassword(password: string): void {
  if (password.length === 0) {
    throw new Error("Enter a password.");
  }
}

function isDuplicateKeyError(reason: unknown): boolean {
  return (
    typeof reason === "object" &&
    reason !== null &&
    (reason as { name?: unknown }).name === "ConstraintError"
  );
}

function getWebCrypto(): Crypto {
  if (globalThis.crypto?.subtle === undefined) {
    throw new Error("This browser does not support the Web Crypto API.");
  }

  return globalThis.crypto;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const webCrypto = getWebCrypto();
  const material = await webCrypto.subtle.importKey(
    "raw",
    toArrayBuffer(encoder.encode(password)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return webCrypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations,
      salt: toArrayBuffer(salt),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt", "encrypt"],
  );
}

function createAccountSecrets(): AccountSecrets {
  const identitySeed = getWebCrypto().getRandomValues(new Uint8Array(32));

  return {
    version: 1,
    identitySeed: bytesToBase64(identitySeed),
  };
}

async function encryptAccountSecrets(
  secrets: AccountSecrets,
  password: string,
): Promise<EncryptedAccountData> {
  const webCrypto = getWebCrypto();
  const salt = webCrypto.getRandomValues(new Uint8Array(16));
  const iv = webCrypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, KDF_ITERATIONS);
  const plaintext = toArrayBuffer(encoder.encode(JSON.stringify(secrets)));
  const ciphertext = await webCrypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    plaintext,
  );

  return {
    version: 1,
    kdf: {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: KDF_ITERATIONS,
      salt: bytesToBase64(salt),
    },
    cipher: {
      name: "AES-GCM",
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    },
  };
}

async function decryptAccountSecrets(
  encryptedData: EncryptedAccountData,
  password: string,
): Promise<AccountSecrets> {
  try {
    if (
      encryptedData.version !== 1 ||
      encryptedData.kdf.name !== "PBKDF2" ||
      encryptedData.kdf.hash !== "SHA-256" ||
      encryptedData.cipher.name !== "AES-GCM"
    ) {
      throw new Error("Unsupported account encryption format.");
    }

    const webCrypto = getWebCrypto();
    const salt = base64ToBytes(encryptedData.kdf.salt);
    const iv = base64ToBytes(encryptedData.cipher.iv);
    const ciphertext = base64ToBytes(encryptedData.cipher.ciphertext);
    const key = await deriveKey(password, salt, encryptedData.kdf.iterations);
    const plaintext = await webCrypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(ciphertext),
    );
    const parsed: unknown = JSON.parse(decoder.decode(plaintext));

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as AccountSecrets).version !== 1 ||
      typeof (parsed as AccountSecrets).identitySeed !== "string"
    ) {
      throw new Error("Unsupported account data.");
    }

    return parsed as AccountSecrets;
  } catch (reason) {
    if (reason instanceof Error && reason.message.startsWith("Unsupported")) {
      throw reason;
    }

    throw incorrectPassword;
  }
}

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

async function openAccountStorage(databaseName: string): Promise<IDBDatabase> {
  if (globalThis.indexedDB === undefined) {
    throw new Error("This browser does not support IndexedDB.");
  }

  return await new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(databaseName, 1);

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "username" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open account storage."));
  });
}
