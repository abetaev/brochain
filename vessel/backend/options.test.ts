// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { createSignals } from "./signals";
import type {
  PersistentKeyValueStorage,
  PersistentServiceStorage,
} from "./storage";
import { createOptions, type OptionValue } from "./options";

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
  const entries = vi.fn(async () => [...values] as readonly (readonly [string, unknown])[]);
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

describe("Options", () => {
  it("loads scalar values from the default store and removes invalid values", async () => {
    const storage = createPersistentStorage([
      ["string", "value"],
      ["number", 42],
      ["boolean", false],
      ["null", null],
      ["object", { nested: true }],
      ["array", ["value"]],
      ["undefined", undefined],
    ]);

    const options = await createOptions(storage.service, createSignals());

    expect(storage.access).toHaveBeenCalledOnce();
    expect(storage.access).toHaveBeenCalledWith(undefined);
    expect(options.get("string")).toBe("value");
    expect(options.get("number")).toBe(42);
    expect(options.get("boolean")).toBe(false);
    expect(options.get("null")).toBeNull();
    expect(options.get("object")).toBeUndefined();
    expect(storage.store.delete.mock.calls).toEqual([
      ["object"],
      ["array"],
      ["undefined"],
    ]);

    const listener = vi.fn();
    options.changes.subscribe(listener);
    expect(listener).not.toHaveBeenCalled();
  });

  it("accepts arbitrary keys and rejects non-scalar runtime values", async () => {
    const storage = createPersistentStorage();
    const options = await createOptions(storage.service, createSignals());
    const key = " spaces/and.objects[are].not-normalized ";

    await options.set(key, true);

    expect(options.get(key)).toBe(true);
    expect(storage.store.put).toHaveBeenCalledWith(key, true);
    for (const invalid of [{}, [], undefined, () => undefined]) {
      await expect(options.set("invalid", invalid as OptionValue)).rejects.toThrow(
        "only scalar values",
      );
    }
    expect(storage.store.put).toHaveBeenCalledOnce();
  });

  it("persists before updating its projection and publishing exact changes", async () => {
    const storage = createPersistentStorage([["theme", "light"]]);
    const options = await createOptions(storage.service, createSignals());
    const persistence = deferred();
    storage.store.put.mockImplementationOnce(async (key, value) => {
      await persistence.promise;
      storage.values.set(key, value);
    });
    const observed: unknown[] = [];
    options.changes.subscribe((change) => {
      observed.push([change, options.get(change.key)]);
    });

    const update = options.set("theme", "dark");
    await Promise.resolve();

    expect(options.get("theme")).toBe("light");
    expect(observed).toEqual([]);
    persistence.resolve();
    await update;
    expect(observed).toEqual([
      [{ key: "theme", value: "dark" }, "dark"],
    ]);

    await options.unset("theme");
    expect(options.get("theme")).toBeUndefined();
    expect(observed.at(-1)).toEqual([
      { key: "theme", value: undefined },
      undefined,
    ]);
  });

  it("serializes mutations, suppresses no-ops, and recovers its queue", async () => {
    const storage = createPersistentStorage();
    const options = await createOptions(storage.service, createSignals());
    const persistence = deferred();
    storage.store.put.mockImplementationOnce(async (key, value) => {
      await persistence.promise;
      storage.values.set(key, value);
    });
    const listener = vi.fn();
    options.changes.subscribe(listener);

    const first = options.set("first", 1);
    const second = options.set("second", 2);
    await Promise.resolve();
    expect(storage.store.put).toHaveBeenCalledTimes(1);

    persistence.resolve();
    await Promise.all([first, second]);
    expect(storage.store.put.mock.calls).toEqual([
      ["first", 1],
      ["second", 2],
    ]);
    expect(listener.mock.calls).toEqual([
      [{ key: "first", value: 1 }],
      [{ key: "second", value: 2 }],
    ]);

    await options.set("second", 2);
    await options.unset("missing");
    expect(storage.store.put).toHaveBeenCalledTimes(2);
    expect(storage.store.delete).not.toHaveBeenCalled();

    const failure = new Error("Persistence failed.");
    storage.store.put.mockRejectedValueOnce(failure);
    const failed = options.set("failed", true);
    const recovered = options.set("recovered", true);
    await expect(failed).rejects.toBe(failure);
    await expect(recovered).resolves.toBeUndefined();
    expect(options.get("failed")).toBeUndefined();
    expect(options.get("recovered")).toBe(true);
    expect(listener).not.toHaveBeenCalledWith({ key: "failed", value: true });
  });

  it("isolates subscriber failures from persistence and other subscribers", async () => {
    const storage = createPersistentStorage();
    const options = await createOptions(storage.service, createSignals());
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const listener = vi.fn();
    options.changes.subscribe(() => {
      throw new Error("Consumer failed.");
    });
    options.changes.subscribe(listener);

    await expect(options.set("enabled", true)).resolves.toBeUndefined();

    expect(storage.values.get("enabled")).toBe(true);
    expect(listener).toHaveBeenCalledWith({ key: "enabled", value: true });
    expect(diagnostic).toHaveBeenCalledWith("Signals subscriber failed.");
  });

  it("makes failed invalid-value cleanup observable and retryable", async () => {
    const storage = createPersistentStorage([["invalid", { value: true }]]);
    const failure = new Error("Cleanup failed.");
    storage.store.delete.mockRejectedValueOnce(failure);

    await expect(createOptions(storage.service, createSignals())).rejects.toBe(failure);
    const options = await createOptions(storage.service, createSignals());

    expect(options.get("invalid")).toBeUndefined();
    expect(storage.store.delete).toHaveBeenCalledTimes(2);
    expect(storage.values.has("invalid")).toBe(false);
  });
});
