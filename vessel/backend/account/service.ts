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

// The same secrets wrapped by an authenticator instead of a password. The key is
// the pseudo-random function's output for the stored salt, which the authenticator
// re-derives at each unlock and nothing keeps.
interface AuthenticatorWrapping {
  version: 1;
  credentialId: string;
  salt: string;
  cipher: {
    name: "AES-GCM";
    iv: string;
    ciphertext: string;
  };
}

// What an authenticator ceremony needs to derive the key again.
interface AuthenticatorCredential {
  credentialId: string;
  salt: string;
}

interface StoredAccount {
  version: 3;
  username: string;
  createdAt: string;
  encryptedData: EncryptedAccountData;
  authenticator?: AuthenticatorWrapping;
}

const applicationDatabaseName = "brochain";
const accountsStoreName = "accounts";
const KDF_ITERATIONS = 310_000;
const usernamePattern = /^[a-z]{1,64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const incorrectPassword = new Error("The password is incorrect.");
const authenticatorDidNotUnlock = new Error("This device did not unlock the account.");

export function createAccountService(databaseName = applicationDatabaseName) {
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
    const transaction = (await storage).transaction(accountsStoreName);
    return await requestResult(operation(transaction.objectStore(accountsStoreName)));
  }

  async function write(operation: (accounts: IDBObjectStore) => IDBRequest): Promise<void> {
    const transaction = (await storage).transaction(accountsStoreName, "readwrite");
    const completion = transactionResult(transaction);
    try {
      await requestResult(operation(transaction.objectStore(accountsStoreName)));
      await completion;
    } catch (reason) {
      await completion.catch(() => undefined);
      throw reason;
    }
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
      version: 3,
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

  function unlockedAccount(): PeerIdentity {
    if (active === undefined) throw new Error("The account is not unlocked.");
    return active;
  }

  async function storedAccount(username: string): Promise<StoredAccount> {
    const account = await get(username);

    if (account === undefined) {
      throw new Error("The account is no longer stored by this application.");
    }

    return account;
  }

  async function readAuthenticator(
    username: string,
  ): Promise<AuthenticatorCredential | undefined> {
    assertUsername(username);
    const wrapping = (await get(username))?.authenticator;

    return wrapping === undefined
      ? undefined
      : { credentialId: wrapping.credentialId, salt: wrapping.salt };
  }

  async function enrolAuthenticator(credentialId: string, salt: string, secret: string) {
    const { username, ...secrets } = unlockedAccount();
    const account = await storedAccount(username);
    const authenticator = await wrapWithAuthenticator(secrets, credentialId, salt, secret);
    await write((accounts) =>
      accounts.put({ ...account, authenticator } satisfies StoredAccount));
  }

  async function removeAuthenticator() {
    const account = await storedAccount(unlockedAccount().username);
    const { authenticator, ...remaining } = account;
    await write((accounts) => accounts.put(remaining satisfies StoredAccount));
  }

  async function unlockWithAuthenticator(username: string, secret: string) {
    assertUsername(username);
    const account = await storedAccount(username);

    if (account.authenticator === undefined) throw authenticatorDidNotUnlock;

    const secrets = await unwrapWithAuthenticator(account.authenticator, secret);
    active = { username: account.username, ...secrets };
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

    await deleteAccountStorage(databaseName, username);
    if (!await deleteStoredAccount(account)) return false;

    if (active?.username === username) {
      active = undefined;
    }

    return true;
  }

  async function exportAccount(username: string): Promise<string> {
    assertUsername(username);
    // A credential belongs to one origin on one device, so its wrapping unlocks
    // nothing anywhere else and its identifier names that device.
    const { authenticator, ...portable } = await storedAccount(username);
    return JSON.stringify(portable, null, 2);
  }

  async function deleteStoredAccount(account: StoredAccount): Promise<boolean> {
    const transaction = (await storage).transaction(accountsStoreName, "readwrite");
    const completion = transactionResult(transaction);
    const accounts = transaction.objectStore(accountsStoreName);
    try {
      const current = await requestResult<StoredAccount | undefined>(
        accounts.get(account.username),
      );
      if (current === undefined || !sameAccount(current, account)) {
        await completion;
        return false;
      }
      await requestResult(accounts.delete(account.username));
      await completion;
      return true;
    } catch (reason) {
      await completion.catch(() => undefined);
      throw reason;
    }
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
    authenticator: readAuthenticator,
    create: (username: string, password: string) =>
      mutate(async () => await create(username, password)),
    unlock: (username: string, password: string) =>
      mutate(async () => await unlock(username, password)),
    unlockWithAuthenticator: (username: string, secret: string) =>
      mutate(async () => await unlockWithAuthenticator(username, secret)),
    enrolAuthenticator: (credentialId: string, salt: string, secret: string) =>
      mutate(async () => await enrolAuthenticator(credentialId, salt, secret)),
    removeAuthenticator: () => mutate(removeAuthenticator),
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
    return parseAccountSecrets(plaintext);
  } catch (reason) {
    if (reason instanceof Error && reason.message.startsWith("Unsupported")) {
      throw reason;
    }

    throw incorrectPassword;
  }
}

function parseAccountSecrets(plaintext: ArrayBuffer): AccountSecrets {
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
}

// The pseudo-random function's output is already a uniform secret of its own for
// that salt and credential, so it is the key rather than material for one.
async function importAuthenticatorKey(secret: string): Promise<CryptoKey> {
  return await getWebCrypto().subtle.importKey(
    "raw",
    toArrayBuffer(base64ToBytes(secret)),
    { name: "AES-GCM" },
    false,
    ["decrypt", "encrypt"],
  );
}

async function wrapWithAuthenticator(
  secrets: AccountSecrets,
  credentialId: string,
  salt: string,
  secret: string,
): Promise<AuthenticatorWrapping> {
  const webCrypto = getWebCrypto();
  const iv = webCrypto.getRandomValues(new Uint8Array(12));
  const key = await importAuthenticatorKey(secret);
  const ciphertext = await webCrypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(encoder.encode(JSON.stringify(secrets))),
  );

  return {
    version: 1,
    credentialId,
    salt,
    cipher: {
      name: "AES-GCM",
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    },
  };
}

async function unwrapWithAuthenticator(
  wrapping: AuthenticatorWrapping,
  secret: string,
): Promise<AccountSecrets> {
  try {
    if (wrapping.version !== 1 || wrapping.cipher.name !== "AES-GCM") {
      throw new Error("Unsupported account encryption format.");
    }

    const key = await importAuthenticatorKey(secret);
    const plaintext = await getWebCrypto().subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(base64ToBytes(wrapping.cipher.iv)) },
      key,
      toArrayBuffer(base64ToBytes(wrapping.cipher.ciphertext)),
    );

    return parseAccountSecrets(plaintext);
  } catch (reason) {
    if (reason instanceof Error && reason.message.startsWith("Unsupported")) {
      throw reason;
    }

    throw authenticatorDidNotUnlock;
  }
}

function sameAccount(left: StoredAccount, right: StoredAccount): boolean {
  return left.version === right.version &&
    left.username === right.username &&
    left.createdAt === right.createdAt &&
    left.encryptedData.cipher.ciphertext === right.encryptedData.cipher.ciphertext;
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

async function openAccountStorage(databaseName: string): Promise<IDBDatabase> {
  if (globalThis.indexedDB === undefined) {
    throw new Error("This browser does not support IndexedDB.");
  }

  return await new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(databaseName, 1);

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(accountsStoreName)) {
        request.result.createObjectStore(accountsStoreName, { keyPath: "username" });
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(
      request.error ?? new Error("Unable to open account storage."),
    );
  });
}

function deleteAccountStorage(databaseName: string, username: string): Promise<void> {
  if (globalThis.indexedDB === undefined) {
    return Promise.reject(new Error("This browser does not support IndexedDB."));
  }

  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.deleteDatabase(`${databaseName}/${username}`);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(
      request.error ?? new Error("Unable to delete account Storage."),
    );
  });
}
