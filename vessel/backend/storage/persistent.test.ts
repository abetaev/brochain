// @vitest-environment node

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPersistentRoot, type PersistentRoot } from "./persistent";

let applicationDatabaseName: string;
let roots: PersistentRoot[];
let databases: Set<string>;

beforeEach(() => {
  applicationDatabaseName = `brochain-storage-test-${crypto.randomUUID()}`;
  roots = [];
  databases = new Set();
});

afterEach(async () => {
  await Promise.allSettled(roots.map(async (root) => await root.close()));
  await Promise.all([...databases].map(deleteDatabase));
});

async function storage(username: string): Promise<PersistentRoot> {
  const root = await createPersistentRoot(`${applicationDatabaseName}/${username}`);
  roots.push(root);
  databases.add(`${applicationDatabaseName}/${username}`);
  return root;
}

describe("persistent Storage", () => {
  it("returns stable stores and keeps every hierarchy dimension independent", async () => {
    const root = await storage("ada");
    const service = root.peer("peer").service("options");
    const values = service.kv<string>();

    expect(root.peer("peer")).toBe(root.peer("peer"));
    expect(service).toBe(root.peer("peer").service("options"));
    expect(values).toBe(service.kv<string>());
    expect(service.kv<string>("")).not.toBe(values);

    await values.put("key", "default");
    await service.kv<string>("").put("key", "empty-name");
    await root.peer("peer").service("other").kv<string>().put("key", "other-service");
    await root.peer("other-peer").service("options").kv<string>().put("key", "other-peer");

    await expect(values.get("key")).resolves.toBe("default");
    await expect(service.kv<string>("").get("key")).resolves.toBe("empty-name");
    await expect(root.peer("peer").service("other").kv<string>().get("key"))
      .resolves.toBe("other-service");
    await expect(root.peer("other-peer").service("options").kv<string>().get("key"))
      .resolves.toBe("other-peer");
  });

  it("provides asynchronous CRUD and immutable entries in IndexedDB key order", async () => {
    const values = (await storage("ada"))
      .peer("local")
      .service("options")
      .kv<{ enabled: boolean }>();

    await expect(values.get("missing")).resolves.toBeUndefined();
    await values.put("zeta", { enabled: false });
    await values.put("alpha", { enabled: true });
    const snapshot = await values.entries();
    await values.put("middle", { enabled: true });
    await values.delete("zeta");

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.every(Object.isFrozen)).toBe(true);
    expect(snapshot).toEqual([
      ["alpha", { enabled: true }],
      ["zeta", { enabled: false }],
    ]);
    await expect(values.entries()).resolves.toEqual([
      ["alpha", { enabled: true }],
      ["middle", { enabled: true }],
    ]);
  });

  it("uses IndexedDB structured cloning and reports unsupported values", async () => {
    const root = await storage("ada");
    const values = root
      .peer("local")
      .service("options")
      .kv<{ nested: string[] }>();
    const original = { nested: ["one"] };

    await values.put("copy", original);
    original.nested.push("mutated");

    await expect(values.get("copy")).resolves.toEqual({ nested: ["one"] });
    await expect(
      root.peer("local").service("options")
        .kv<unknown>().put("invalid", () => undefined),
    ).rejects.toMatchObject({ name: "DataCloneError" });
  });

  it("persists values across Storage lifetimes and isolates accounts", async () => {
    const first = await storage("ada");
    const firstValues = first.peer("local").service("options").kv<string>();
    await firstValues.put("theme", "dark");
    await first.close();

    const reopened = await storage("ada");
    await expect(
      reopened.peer("local").service("options").kv<string>().get("theme"),
    ).resolves.toBe("dark");
    await expect(
      (await storage("bea")).peer("local").service("options")
        .kv<string>().get("theme"),
    ).resolves.toBeUndefined();
  });

  it("operates without an Account database", async () => {
    const values = (await storage("unregistered"))
      .peer("local")
      .service("options")
      .kv<string>();

    await values.put("key", "value");

    await expect(values.get("key")).resolves.toBe("value");
    expect((await indexedDB.databases()).map(({ name }) => name))
      .not.toContain(applicationDatabaseName);
  });

  it("rejects eager construction after an open failure and permits a fresh attempt", async () => {
    const databaseName = `${applicationDatabaseName}/ada`;
    databases.add(databaseName);
    const newer = await openDatabaseVersion(databaseName, 3);
    await expect(storage("ada")).rejects.toMatchObject({ name: "VersionError" });

    newer.close();
    await deleteDatabase(databaseName);
    const root = await storage("ada");
    await expect(root.peer("local").service("options").kv().get("key"))
      .resolves.toBeUndefined();
  });

  it("finishes accepted operations during idempotent shutdown", async () => {
    const root = await storage("ada");
    const values = root.peer("local").service("options").kv<string>();
    const pending = values.put("key", "value");

    const firstClose = root.close();
    await expect(pending).resolves.toBeUndefined();
    await expect(firstClose).resolves.toBeUndefined();
    await expect(root.close()).resolves.toBeUndefined();

    const reopened = await storage("ada");
    await expect(
      reopened.peer("local").service("options").kv<string>().get("key"),
    ).resolves.toBe("value");
  });

  it("closes an open database connection when its database is deleted", async () => {
    const databaseName = `${applicationDatabaseName}/ada`;
    const root = await storage("ada");
    const values = root.peer("local").service("options").kv<string>();
    await values.put("key", "value");

    await expect(deleteDatabase(databaseName)).resolves.toBeUndefined();

    expect((await indexedDB.databases()).map(({ name }) => name))
      .not.toContain(databaseName);
  });
});

async function openDatabaseVersion(name: string, version: number): Promise<IDBDatabase> {
  return await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function deleteDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Test database deletion was blocked."));
  });
}
