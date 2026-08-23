// @vitest-environment node

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStorage, type Storage } from "./index";

let applicationDatabaseName: string;
let roots: Storage[];
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

function storage(username: string): Storage {
  const root = createStorage(username, applicationDatabaseName);
  roots.push(root);
  databases.add(`${applicationDatabaseName}/${username}`);
  return root;
}

describe("persistent Storage", () => {
  it("returns stable stores and keeps every hierarchy dimension independent", async () => {
    const root = storage("ada").persistent;
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
    const values = storage("ada").persistent
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
    const root = storage("ada");
    const values = root.persistent
      .peer("local")
      .service("options")
      .kv<{ nested: string[] }>();
    const original = { nested: ["one"] };

    await values.put("copy", original);
    original.nested.push("mutated");

    await expect(values.get("copy")).resolves.toEqual({ nested: ["one"] });
    await expect(
      root.persistent.peer("local").service("options")
        .kv<unknown>().put("invalid", () => undefined),
    ).rejects.toMatchObject({ name: "DataCloneError" });
  });

  it("persists values across Storage lifetimes and isolates accounts", async () => {
    const first = storage("ada");
    const firstValues = first.persistent.peer("local").service("options").kv<string>();
    await firstValues.put("theme", "dark");
    await first.close();

    const reopened = storage("ada");
    await expect(
      reopened.persistent.peer("local").service("options").kv<string>().get("theme"),
    ).resolves.toBe("dark");
    await expect(
      storage("bea").persistent.peer("local").service("options")
        .kv<string>().get("theme"),
    ).resolves.toBeUndefined();
  });

  it("operates without an Account database", async () => {
    const values = storage("unregistered").persistent
      .peer("local")
      .service("options")
      .kv<string>();

    await values.put("key", "value");

    await expect(values.get("key")).resolves.toBe("value");
    expect((await indexedDB.databases()).map(({ name }) => name))
      .not.toContain(applicationDatabaseName);
  });

  it("initializes lazily, reports open failures, and retries a later operation", async () => {
    const databaseName = `${applicationDatabaseName}/ada`;
    databases.add(databaseName);
    const newer = await openDatabaseVersion(databaseName, 3);
    const values = storage("ada").persistent
      .peer("local")
      .service("options")
      .kv<string>();

    await expect(values.get("key")).rejects.toMatchObject({ name: "VersionError" });

    newer.close();
    await deleteDatabase(databaseName);
    await expect(values.get("key")).resolves.toBeUndefined();
  });

  it("finishes accepted operations during shutdown and rejects later operations", async () => {
    const root = storage("ada");
    const values = root.persistent.peer("local").service("options").kv<string>();
    const pending = values.put("key", "value");

    const firstClose = root.close();
    await expect(pending).resolves.toBeUndefined();
    await expect(firstClose).resolves.toBeUndefined();
    await expect(root.close()).resolves.toBeUndefined();
    await expect(values.get("key")).rejects.toThrow("Storage is closed");

    const reopened = storage("ada");
    await expect(
      reopened.persistent.peer("local").service("options").kv<string>().get("key"),
    ).resolves.toBe("value");
  });

  it("invalidates an open root when its account database is deleted", async () => {
    const databaseName = `${applicationDatabaseName}/ada`;
    const root = storage("ada");
    const values = root.persistent.peer("local").service("options").kv<string>();
    await values.put("key", "value");

    await deleteDatabase(databaseName);

    await expect(values.get("key")).rejects.toThrow(
      "persistent Storage is no longer available",
    );
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
