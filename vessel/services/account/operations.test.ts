import "fake-indexeddb/auto";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import {
  releaseProxy,
  transfer,
  wrap,
  type Endpoint,
  type Remote,
} from "comlink";
import { describe, expect, it } from "vitest";
import {
  startAccountService,
  type AccountService,
  type SessionAccess,
} from "./service.ts";

function endpoint(port: MessagePort): Endpoint {
  return port as unknown as Endpoint;
}

async function openAccountService(
  databaseName = `brochain-v2-test-${crypto.randomUUID()}`,
) {
  const operationsChannel = new MessageChannel();
  const sessionChannel = new MessageChannel();
  startAccountService(endpoint(operationsChannel.port1), databaseName);
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

describe("account operations and access", () => {
  it("persists encrypted accounts while exposing identity only to a Session", async () => {
    const databaseName = `brochain-v2-test-${crypto.randomUUID()}`;
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
});
