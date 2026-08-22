import { describe, expect, it, vi } from "vitest";
import { createSignals } from "./signals.ts";
import {
  createStorage,
  type EventStorageChange,
  type KeyValueStorageChange,
  type SingletonStorageChange,
} from "./storage.ts";

function testStorage() {
  const signals = createSignals();
  return { signals, storage: createStorage(signals) };
}

describe("Session Storage", () => {
  it("returns stable scopes for each peer identity and service", () => {
    const { storage } = testStorage();
    const peer = storage.peer("peer");
    const service = peer.service("messaging");

    expect(storage.peer("peer")).toBe(peer);
    expect(peer.service("messaging")).toBe(service);
    expect(storage.peer("other-peer")).not.toBe(peer);
    expect(peer.service("identity")).not.toBe(service);
  });

  it("retains events, publishes them after append, and returns immutable snapshots", () => {
    const { signals, storage } = testStorage();
    const events = storage.peer("peer").service("messaging").event<string>();
    const listener = vi.fn((change: EventStorageChange) => {
      expect(events.read()).toEqual(["first"]);
      expect(change).toEqual({ operation: "append" });
    });
    const unsubscribe = signals.subscribe(events.changes, listener);

    events.append("first");
    const snapshot = events.read();
    unsubscribe();
    events.append("second");

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ operation: "append" });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).toEqual(["first"]);
    expect(events.read()).toEqual(["first", "second"]);
  });

  it("retains a mutation before propagating a subscriber failure", () => {
    const { signals, storage } = testStorage();
    const events = storage.peer("peer").service("messaging").event<string>();
    const failure = new Error("Subscriber failed.");
    signals.subscribe(events.changes, () => {
      throw failure;
    });

    expect(() => events.append("retained")).toThrow(failure);
    expect(events.read()).toEqual(["retained"]);
  });

  it("stores, clears, and publishes singleton values after mutation", () => {
    const { signals, storage } = testStorage();
    const value = storage.peer("peer").service("identity").singleton<string>();
    const listener = vi.fn((change: SingletonStorageChange) => {
      expect(value.get()).toBe(change.operation === "put" ? "current" : undefined);
    });
    const unsubscribe = signals.subscribe(value.changes, listener);

    expect(value.get()).toBeUndefined();
    value.put("current");
    value.clear();
    unsubscribe();
    value.put("ignored");

    expect(listener.mock.calls).toEqual([
      [{ operation: "put" }],
      [{ operation: "clear" }],
    ]);
    expect(value.get()).toBe("ignored");
  });

  it("stores, deletes, and publishes key/value entries after mutation", () => {
    const { signals, storage } = testStorage();
    const values = storage.peer("peer").service("contacts").kv<number>();
    const observations: Array<{
      readonly change: KeyValueStorageChange;
      readonly value: number | undefined;
    }> = [];
    const listener = vi.fn((change: KeyValueStorageChange) => {
      observations.push({ change, value: values.get(change.key) });
    });
    const unsubscribe = signals.subscribe(values.changes, listener);

    values.put("ada", 1);
    values.put("bob", 2);
    const snapshot = values.entries();
    values.delete("ada");
    unsubscribe();
    values.put("ignored", 3);

    expect(listener.mock.calls).toEqual([
      [{ operation: "put", key: "ada" }],
      [{ operation: "put", key: "bob" }],
      [{ operation: "delete", key: "ada" }],
    ]);
    expect(observations).toEqual([
      { change: { operation: "put", key: "ada" }, value: 1 },
      { change: { operation: "put", key: "bob" }, value: 2 },
      { change: { operation: "delete", key: "ada" }, value: undefined },
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.every(Object.isFrozen)).toBe(true);
    expect(snapshot).toEqual([["ada", 1], ["bob", 2]]);
    expect(values.entries()).toEqual([["bob", 2], ["ignored", 3]]);
  });

  it("keeps storage kinds, default names, and named stores independent", () => {
    const { storage } = testStorage();
    const service = storage.peer("peer").service("service");
    const events = service.event<string>();
    const namedEvents = service.event<string>("");
    const singleton = service.singleton<string>();
    const keyValues = service.kv<string>();

    events.append("event");
    namedEvents.append("named");
    singleton.put("singleton");
    keyValues.put("key", "value");

    expect(service.event<string>()).toBe(events);
    expect(service.event<string>("")).toBe(namedEvents);
    expect(service.singleton<string>()).toBe(singleton);
    expect(service.kv<string>()).toBe(keyValues);
    expect(events.read()).toEqual(["event"]);
    expect(namedEvents.read()).toEqual(["named"]);
    expect(singleton.get()).toBe("singleton");
    expect(keyValues.entries()).toEqual([["key", "value"]]);
  });

  it("isolates peer, service, and Session scopes", () => {
    const first = testStorage().storage;
    const second = testStorage().storage;
    const events = first.peer("peer").service("messaging").event<string>();

    events.append("first Session only");

    expect(first.peer("other").service("messaging").event().read()).toEqual([]);
    expect(first.peer("peer").service("other").event().read()).toEqual([]);
    expect(second.peer("peer").service("messaging").event().read()).toEqual([]);
  });
});
