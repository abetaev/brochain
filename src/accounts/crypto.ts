import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import type { AccountSecrets, EncryptedAccountData } from "./types";

const KDF_ITERATIONS = 310_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function getWebCrypto(): Crypto {
  if (globalThis.crypto?.subtle === undefined) {
    throw new Error("This browser does not support the Web Crypto API.");
  }

  return globalThis.crypto;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let value = "";

  for (const byte of bytes) {
    value += String.fromCharCode(byte);
  }

  return btoa(value);
}

export function base64ToBytes(value: string): Uint8Array {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
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
      iterations: KDF_ITERATIONS,
      salt: toArrayBuffer(salt),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt", "encrypt"],
  );
}

export class IncorrectPasswordError extends Error {
  constructor() {
    super("The password is incorrect.");
  }
}

export async function createAccountSecrets(): Promise<AccountSecrets> {
  const identitySeed = getWebCrypto().getRandomValues(new Uint8Array(32));
  const privateKey = await generateKeyPairFromSeed("Ed25519", identitySeed);

  return {
    version: 1,
    peerId: peerIdFromPrivateKey(privateKey).toString(),
    identitySeed: bytesToBase64(identitySeed),
  };
}

export async function encryptAccountSecrets(
  secrets: AccountSecrets,
  password: string,
): Promise<EncryptedAccountData> {
  const webCrypto = getWebCrypto();
  const salt = webCrypto.getRandomValues(new Uint8Array(16));
  const iv = webCrypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
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

export async function decryptAccountSecrets(
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
    const material = await webCrypto.subtle.importKey(
      "raw",
      toArrayBuffer(encoder.encode(password)),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    const key = await webCrypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        iterations: encryptedData.kdf.iterations,
        salt: toArrayBuffer(salt),
      },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
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
      typeof (parsed as AccountSecrets).peerId !== "string" ||
      typeof (parsed as AccountSecrets).identitySeed !== "string"
    ) {
      throw new Error("Unsupported account data.");
    }

    return parsed as AccountSecrets;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unsupported")) {
      throw error;
    }

    throw new IncorrectPasswordError();
  }
}
