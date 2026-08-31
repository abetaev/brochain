// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type {
  PersistentKeyValueStorage,
  PersistentServiceStorage,
} from "./storage";
import {
  createOptions,
  type OptionObjects,
  type Options,
} from "./options";

type TestSchema = {
  settings: OptionObjects<"current" | "alternate", {
    text: string;
    count: number;
    flag: boolean;
    empty: null;
  }>;
} & {
  settings: OptionObjects<"current" | "alternate", {
    nested: OptionObjects<string, {
      enabled: boolean;
    }>;
  }>;
};

function createPersistentStorage(
  initial: readonly (readonly [string, unknown])[] = [],
) {
  const values = new Map(initial);
  const get = vi.fn(async (key: string) => values.get(key));
  const put = vi.fn(async (key: string, value: unknown) => {
    values.set(key, value);
  });
  const remove = vi.fn(async (key: string) => {
    values.delete(key);
  });
  const entries = vi.fn(async () =>
    [...values] as readonly (readonly [string, unknown])[]
  );
  const store = { get, put, delete: remove, entries };
  const access = vi.fn();
  const service: PersistentServiceStorage = {
    kv<T>(name?: string) {
      access(name);
      return store as PersistentKeyValueStorage<T>;
    },
  };
  return { service, store, values, access };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function testOptions(
  storage = createPersistentStorage(),
): Promise<Options<TestSchema>> {
  return await createOptions<TestSchema>(storage.service);
}

describe("Options", () => {
  it("loads scalar values and removes invalid persisted values", async () => {
    const storage = createPersistentStorage([
      ["settings/current.text", "value"],
      ["settings/current.count", 42],
      ["settings/current.flag", false],
      ["settings/current.empty", null],
      ["object", { nested: true }],
      ["array", ["value"]],
      ["undefined", undefined],
    ]);

    const options = await testOptions(storage);
    const current = options.cat("settings").obj("current");

    expect(storage.access).toHaveBeenCalledOnce();
    expect(storage.access).toHaveBeenCalledWith(undefined);
    expect(current.get("text")).toBe("value");
    expect(current.get("count")).toBe(42);
    expect(current.get("flag")).toBe(false);
    expect(current.get("empty")).toBeNull();
    expect(storage.store.delete.mock.calls).toEqual([
      ["object"],
      ["array"],
      ["undefined"],
    ]);

    const listener = vi.fn();
    current.observe("text", listener);
    expect(listener).not.toHaveBeenCalled();
  });

  it("serializes recursive scopes and encodes dynamic object identifiers", async () => {
    const storage = createPersistentStorage();
    const options = await testOptions(storage);
    const current = options.cat("settings").obj("current");

    await current.set("text", "value");
    await current.cat("nested").obj("service/one.two%")
      .set("enabled", true);

    expect(storage.store.put.mock.calls).toEqual([
      ["settings/current.text", "value"],
      ["settings/current/nested/service%2Fone%2Etwo%25.enabled", true],
    ]);
    expect(options.cat("settings").obj("current")).not.toBe(current);
    expect(options.cat("settings").obj("current").get("text")).toBe("value");
  });

  it("rejects ambiguous scope names, empty identifiers, and non-scalars", async () => {
    const storage = createPersistentStorage();
    const options = await testOptions(storage);
    const root = options as unknown as {
      cat(name: string): {
        obj(identifier: string): {
          get(name: string): unknown;
          set(name: string, value: unknown): Promise<void>;
          cat(name: string): unknown;
        };
      };
    };

    expect(() => root.cat("")).toThrow("category names");
    expect(() => root.cat("bad/category")).toThrow("category names");
    expect(() => root.cat("bad.category")).toThrow("category names");
    expect(() => root.cat("settings").obj("")).toThrow("identifiers");
    expect(() => root.cat("settings").obj("current").get(""))
      .toThrow("property names");
    expect(() => root.cat("settings").obj("current").get("bad.property"))
      .toThrow("property names");
    expect(() => root.cat("settings").obj("current").cat("bad/category"))
      .toThrow("category names");
    await expect(root.cat("settings").obj("current").set("text", {}))
      .rejects.toThrow("only scalar values");
    expect(storage.store.put).not.toHaveBeenCalled();
  });

  it("persists before projection changes and property observation", async () => {
    const storage = createPersistentStorage([["settings/current.text", "light"]]);
    const options = await testOptions(storage);
    const current = options.cat("settings").obj("current");
    const persistence = deferred();
    storage.store.put.mockImplementationOnce(async (key, value) => {
      await persistence.promise;
      storage.values.set(key, value);
    });
    const observed: unknown[] = [];
    current.observe("text", (value) => {
      observed.push([value, current.get("text")]);
    });
    current.observe("count", (value) => observed.push(["count", value]));
    options.cat("settings").obj("alternate")
      .observe("text", (value) => observed.push(["alternate", value]));

    const update = current.set("text", "dark");
    await Promise.resolve();

    expect(current.get("text")).toBe("light");
    expect(observed).toEqual([]);
    persistence.resolve();
    await update;
    expect(observed).toEqual([["dark", "dark"]]);

    await current.unset("text");
    expect(current.get("text")).toBeUndefined();
    expect(observed.at(-1)).toEqual([undefined, undefined]);
  });

  it("orders observations and supports independent idempotent unsubscribe", async () => {
    const options = await testOptions();
    const first = vi.fn();
    const second = vi.fn();
    const current = options.cat("settings").obj("current");
    const stopFirst = current.observe("flag", first);
    current.observe("flag", second);

    await current.set("flag", true);
    expect(first.mock.invocationCallOrder[0])
      .toBeLessThan(second.mock.invocationCallOrder[0]!);

    stopFirst();
    stopFirst();
    await current.set("flag", false);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("suppresses no-ops and permits later mutations after failure", async () => {
    const storage = createPersistentStorage();
    const options = await testOptions(storage);
    const current = options.cat("settings").obj("current");
    const listener = vi.fn();
    current.observe("count", listener);

    await current.set("count", 1);
    await current.set("count", 1);
    await current.unset("text");
    expect(storage.store.put).toHaveBeenCalledOnce();
    expect(storage.store.delete).not.toHaveBeenCalled();

    const failure = new Error("Persistence failed.");
    storage.store.put.mockRejectedValueOnce(failure);
    await expect(current.set("count", 2)).rejects.toBe(failure);
    expect(current.get("count")).toBe(1);

    await expect(current.set("count", 3)).resolves.toBeUndefined();
    expect(current.get("count")).toBe(3);
    expect(listener.mock.calls).toEqual([[1], [3]]);
  });

  it("isolates subscriber failures from persistence and later observers", async () => {
    const storage = createPersistentStorage();
    const options = await testOptions(storage);
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const listener = vi.fn();
    const current = options.cat("settings").obj("current");
    current.observe("flag", () => {
      throw new Error("Consumer failed.");
    });
    current.observe("flag", listener);

    await expect(current.set("flag", true)).resolves.toBeUndefined();

    expect(storage.values.get("settings/current.flag")).toBe(true);
    expect(listener).toHaveBeenCalledWith(true);
    expect(diagnostic).toHaveBeenCalledWith("Channel subscriber failed.");
  });

  it("makes failed invalid-value cleanup observable and retryable", async () => {
    const storage = createPersistentStorage([["invalid", { value: true }]]);
    const failure = new Error("Cleanup failed.");
    storage.store.delete.mockRejectedValueOnce(failure);

    await expect(createOptions<TestSchema>(storage.service))
      .rejects.toBe(failure);
    const options = await testOptions(storage);

    expect(options.cat("settings").obj("current").get("text")).toBeUndefined();
    expect(storage.store.delete).toHaveBeenCalledTimes(2);
    expect(storage.values.has("invalid")).toBe(false);
  });
});

function verifyTypes(options: Options<TestSchema>): void {
  const current = options.cat("settings").obj("current");
  const text: string | undefined = current.get("text");
  const enabled: boolean | undefined = current.cat("nested").obj("service")
    .get("enabled");
  current.observe("count", (value: number | undefined) => value);
  void text;
  void enabled;

  // @ts-expect-error unknown category
  options.cat("unknown");
  // @ts-expect-error object identifier outside the schema
  options.cat("settings").obj("missing");
  // @ts-expect-error unknown property
  current.get("missing");
  // @ts-expect-error wrong property value
  current.set("text", false);
  // @ts-expect-error scalar properties are not categories
  current.cat("text");
}

void verifyTypes;
