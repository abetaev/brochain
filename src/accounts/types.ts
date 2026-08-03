export interface AccountSecrets {
  version: 1;
  peerId: string;
  identitySeed: string;
}

export interface EncryptedAccountData {
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

export interface StoredAccount {
  id: string;
  name: string;
  createdAt: string;
  encryptedData: EncryptedAccountData;
}

export interface UnlockedAccount {
  id: string;
  name: string;
  createdAt: string;
  secrets: AccountSecrets;
}

export interface AccountRepository {
  list(): Promise<StoredAccount[]>;
  get(id: string): Promise<StoredAccount | undefined>;
  put(account: StoredAccount): Promise<void>;
  delete(id: string): Promise<void>;
}
