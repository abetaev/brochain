import "fake-indexeddb/auto";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import {
  expose,
  releaseProxy,
  transfer,
  wrap,
  type Endpoint,
  type Remote,
} from "comlink";
import { describe, expect, it, vi } from "vitest";
import { bytesToBase64 } from "@c/base64";
import {
  createAccountService,
  type AccountService,
  type SessionAccess,
} from "./service.ts";
import {
  createPersistentRoot,
  type PersistentRoot,
} from "@v/backend/storage/persistent";

function endpoint(port: MessagePort): Endpoint {
  return port as unknown as Endpoint;
}

async function openAccountService(
  databaseName = `brochain-test-${crypto.randomUUID()}`,
) {
  const operationsChannel = new MessageChannel();
  const sessionChannel = new MessageChannel();
  expose(createAccountService(databaseName), endpoint(operationsChannel.port1));
  const operations = wrap<AccountService>(endpoint(operationsChannel.port2));
  await operations.openSession(
    transfer(endpoint(sessionChannel.port1), [
      sessionChannel.port1 as unknown as Transferable,
    ]),
  );
  const session = wrap<SessionAccess>(endpoint(sessionChannel.port2));

  return {
    operations,
    session,
    close() {
      operations[releaseProxy]();
      session[releaseProxy]();
      operationsChannel.port1.close();
      operationsChannel.port2.close();
      sessionChannel.port1.close();
      sessionChannel.port2.close();
    },
  };
}

async function expectIdentityIsPrivate(
  operations: Remote<AccountService>,
): Promise<void> {
  const privateOperations = operations as unknown as Remote<SessionAccess>;
  await expect(privateOperations.activePeerIdentity()).rejects.toThrow();
  await expect(privateOperations.closeSession()).rejects.toThrow();
  const secondSession = new MessageChannel();
  try {
    await expect(operations.openSession(
      transfer(endpoint(secondSession.port1), [
        secondSession.port1 as unknown as Transferable,
      ]),
    )).rejects.toThrow("Account Session access is already open.");
  } finally {
    secondSession.port1.close();
    secondSession.port2.close();
  }
}

function authenticatorSecret(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
}

describe("account operations and access", () => {
  it("persists encrypted accounts while exposing identity only to a Session", async () => {
    const databaseName = `brochain-test-${crypto.randomUUID()}`;
    const password = "correct horse battery staple";
    const beforeReload = await openAccountService(databaseName);
    let identitySeed = "";

    try {
      await expectIdentityIsPrivate(beforeReload.operations);
      await expect(beforeReload.operations.create("ada", password)).resolves.toBeUndefined();
      await expect(beforeReload.operations.list()).resolves.toEqual(["ada"]);
      const identity = await beforeReload.session.activePeerIdentity();
      expect(identity).toMatchObject({ username: "ada", version: 1 });
      identitySeed = identity?.identitySeed ?? "";
      expect(identitySeed).not.toBe("");

      const exported = await beforeReload.operations.export("ada");
      expect(exported).toContain('"username": "ada"');
      expect(exported).not.toContain(password);
      expect(exported).not.toContain("identitySeed");
      expect(JSON.parse(exported)).toMatchObject({ version: 3, username: "ada" });
      await beforeReload.session.closeSession();
      await expect(beforeReload.session.activePeerIdentity()).resolves.toBeUndefined();
      await expect(beforeReload.operations.unlock("ada", "wrong password")).rejects.toThrow(
        "The password is incorrect.",
      );
    } finally {
      beforeReload.close();
    }

    const afterReload = await openAccountService(databaseName);

    try {
      await expect(afterReload.operations.list()).resolves.toEqual(["ada"]);
      await expect(afterReload.operations.unlock("ada", password)).resolves.toBeUndefined();
      await expect(afterReload.session.activePeerIdentity()).resolves.toMatchObject({
        username: "ada",
        identitySeed,
      });
    } finally {
      afterReload.close();
    }
  });

  // The ceremony belongs to the window; what reaches the service is its output,
  // so the wrapping is provable here without an authenticator.
  it("wraps the unlocked secrets for an authenticator and unlocks by them", async () => {
    const accounts = await openAccountService();
    const password = "correct horse battery staple";
    const secret = authenticatorSecret();
    const anotherSecret = authenticatorSecret();

    try {
      await accounts.operations.create("ada", password);
      const identitySeed = (await accounts.session.activePeerIdentity())?.identitySeed;
      await expect(accounts.operations.authenticator("ada")).resolves.toBeUndefined();

      await accounts.operations.enrolAuthenticator("a credential", "a salt", secret);
      await expect(accounts.operations.authenticator("ada")).resolves.toEqual({
        credentialId: "a credential",
        salt: "a salt",
      });
      // A credential belongs to one origin on one device, so an export carries none.
      await expect(accounts.operations.export("ada")).resolves.not.toContain("a credential");

      await accounts.session.closeSession();
      await expect(accounts.operations.unlockWithAuthenticator("ada", anotherSecret))
        .rejects.toThrow("This device did not unlock the account.");
      await expect(accounts.session.activePeerIdentity()).resolves.toBeUndefined();

      await accounts.operations.unlockWithAuthenticator("ada", secret);
      await expect(accounts.session.activePeerIdentity()).resolves.toMatchObject({
        username: "ada",
        identitySeed,
      });

      // The same control removes it, and the password was never touched.
      await accounts.operations.removeAuthenticator();
      await expect(accounts.operations.authenticator("ada")).resolves.toBeUndefined();
      await expect(accounts.operations.unlockWithAuthenticator("ada", secret))
        .rejects.toThrow("This device did not unlock the account.");
      await expect(accounts.operations.unlock("ada", password)).resolves.toBeUndefined();

      // Deleting the account deletes the wrapping with it.
      await accounts.operations.enrolAuthenticator("a credential", "a salt", secret);
      await expect(accounts.operations.delete("ada", password)).resolves.toBe(true);
      await expect(accounts.operations.authenticator("ada")).resolves.toBeUndefined();
    } finally {
      accounts.close();
    }
  });

  it("validates creation and requires a password for deletion", async () => {
    const accounts = await openAccountService();

    try {
      await expect(accounts.operations.create("Ada", "a password")).rejects.toThrow(
        "Username must contain 1 to 64 lowercase letters.",
      );
      await expect(accounts.operations.create("bea", "")).rejects.toThrow(
        "Enter a password.",
      );
      await accounts.operations.create("bea", "a password");
      await expect(accounts.operations.create("bea", "another password")).rejects.toThrow(
        "That username is already used by this application.",
      );
      await expect(accounts.operations.delete("bea", "wrong password")).resolves.toBe(false);
      await expect(accounts.operations.list()).resolves.toEqual(["bea"]);
      const deletion = accounts.operations.delete("bea", "a password");
      const staleUnlock = accounts.operations.unlock("bea", "a password");
      await expect(deletion).resolves.toBe(true);
      await expect(staleUnlock).rejects.toThrow(
        "The account is no longer stored by this application.",
      );
      await expect(accounts.operations.list()).resolves.toEqual([]);
      await expect(accounts.session.activePeerIdentity()).resolves.toBeUndefined();
    } finally {
      accounts.close();
    }
  });

  it("deletes the account database before its record and recreates it empty", async () => {
    const databaseName = `brochain-deletion-${crypto.randomUUID()}`;
    const accounts = await openAccountService(databaseName);
    const password = "partition password";
    let staleStorage: PersistentRoot | undefined;
    let replacementStorage: PersistentRoot | undefined;

    try {
      await accounts.operations.create("ada", password);
      staleStorage = await createPersistentRoot(`${databaseName}/ada`);
      const staleValues = staleStorage
        .peer("local")
        .service("options")
        .kv<string>();
      await staleValues.put("theme", "dark");

      await expect(accounts.operations.delete("ada", "wrong password"))
        .resolves.toBe(false);
      await expect(staleValues.get("theme")).resolves.toBe("dark");

      await expect(accounts.operations.delete("ada", password)).resolves.toBe(true);
      await expect(accounts.operations.list()).resolves.toEqual([]);

      await accounts.operations.create("ada", password);
      replacementStorage = await createPersistentRoot(`${databaseName}/ada`);
      await expect(
        replacementStorage.peer("local").service("options")
          .kv<string>().get("theme"),
      ).resolves.toBeUndefined();
    } finally {
      await staleStorage?.close();
      await replacementStorage?.close();
      accounts.close();
    }
  });

  it("retains the account when its database cannot be deleted", async () => {
    const databaseName = `brochain-deletion-failure-${crypto.randomUUID()}`;
    const accounts = await openAccountService(databaseName);
    const storage = await createPersistentRoot(`${databaseName}/cy`);
    await accounts.operations.create("cy", "a password");
    const values = storage.peer("local").service("options").kv<string>();
    await values.put("theme", "dark");
    const deletion = vi.spyOn(indexedDB, "deleteDatabase")
      .mockImplementationOnce(() => {
        throw new DOMException("Deletion denied.", "SecurityError");
      });

    try {
      await expect(accounts.operations.delete("cy", "a password"))
        .rejects.toMatchObject({ name: "SecurityError" });
      await expect(accounts.operations.list()).resolves.toEqual(["cy"]);
      await expect(values.get("theme")).resolves.toBe("dark");
    } finally {
      deletion.mockRestore();
      await storage.close();
      accounts.close();
    }
  });
});
