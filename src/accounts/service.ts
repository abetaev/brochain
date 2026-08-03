import { createAccountSecrets, decryptAccountSecrets, encryptAccountSecrets } from "./crypto";
import type { AccountRepository, StoredAccount, UnlockedAccount } from "./types";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected account error occurred.";
}

export class AccountService {
  constructor(
    private readonly repository: AccountRepository,
    private readonly createId: () => string = () => globalThis.crypto.randomUUID(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(): Promise<StoredAccount[]> {
    return this.repository.list();
  }

  async create(name: string, password: string): Promise<StoredAccount> {
    const normalizedName = name.trim();

    if (normalizedName.length === 0) {
      throw new Error("Enter an account name.");
    }

    if (password.length === 0) {
      throw new Error("Enter a password.");
    }

    const account: StoredAccount = {
      id: this.createId(),
      name: normalizedName,
      createdAt: this.now().toISOString(),
      encryptedData: await encryptAccountSecrets(await createAccountSecrets(), password),
    };

    await this.repository.put(account);
    return account;
  }

  async unlock(id: string, password: string): Promise<UnlockedAccount> {
    const account = await this.repository.get(id);

    if (account === undefined) {
      throw new Error("The account no longer exists on this device.");
    }

    const secrets = await decryptAccountSecrets(account.encryptedData, password);

    return {
      id: account.id,
      name: account.name,
      createdAt: account.createdAt,
      secrets,
    };
  }

  async remove(id: string): Promise<void> {
    await this.repository.delete(id);
  }

  async export(id: string): Promise<string> {
    const account = await this.repository.get(id);

    if (account === undefined) {
      throw new Error("The account no longer exists on this device.");
    }

    return JSON.stringify(account, null, 2);
  }

  static errorMessage(error: unknown): string {
    return getErrorMessage(error);
  }
}
