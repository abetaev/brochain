import { describe, expect, it, vi } from "vitest";
import { createStorage } from "./storage.ts";

describe("Session Storage", () => {
  it("returns stable scopes for each peer identity and service", () => {
    const storage = createStorage();
    const peer = storage.peer("peer");
    const service = peer.service("messaging");

    expect(storage.peer("peer")).toBe(peer);
    expect(peer.service("messaging")).toBe(service);
    expect(storage.peer("other-peer")).not.toBe(peer);
    expect(peer.service("identity")).not.toBe(service);
  });

  it("retains events, publishes them after append, and returns immutable snapshots", () => {
    const events = createStorage().peer("peer").service("messaging").event<string>();
    const listener = vi.fn((event: string) => {
      expect(events.read()).toEqual([event]);
    });
    const unsubscribe = events.subscribe(listener);

    events.append("first");
    const snapshot = events.read();
    unsubscribe();
    events.append("second");

    expect(listener).toHaveBeenCalledOnce();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).toEqual(["first"]);
    expect(events.read()).toEqual(["first", "second"]);
  });

  it("stores, clears, and publishes singleton values after mutation", () => {
    const value = createStorage().peer("peer").service("identity").singleton<string>();
    const listener = vi.fn((next: string | undefined) => {
      expect(value.get()).toBe(next);
    });
    const unsubscribe = value.subscribe(listener);

    expect(value.get()).toBeUndefined();
    value.put("current");
    value.clear();
    unsubscribe();
    value.put("ignored");

    expect(listener.mock.calls).toEqual([["current"], [undefined]]);
    expect(value.get()).toBe("ignored");
  });

  it("stores, deletes, and publishes key/value entries after mutation", () => {
    const values = createStorage().peer("peer").service("contacts").kv<number>();
    const listener = vi.fn((key: string, value: number | undefined) => {
      expect(values.get(key)).toBe(value);
    });
    const unsubscribe = values.subscribe(listener);

    values.put("ada", 1);
    values.put("bob", 2);
    const snapshot = values.entries();
    values.delete("ada");
    unsubscribe();
    values.put("ignored", 3);

    expect(listener.mock.calls).toEqual([
      ["ada", 1],
      ["bob", 2],
      ["ada", undefined],
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.every(Object.isFrozen)).toBe(true);
    expect(snapshot).toEqual([["ada", 1], ["bob", 2]]);
    expect(values.entries()).toEqual([["bob", 2], ["ignored", 3]]);
  });

  it("keeps storage kinds, default names, and named stores independent", () => {
    const service = createStorage().peer("peer").service("service");
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
    const first = createStorage();
    const second = createStorage();
    const events = first.peer("peer").service("messaging").event<string>();

    events.append("first Session only");

    expect(first.peer("other").service("messaging").event().read()).toEqual([]);
    expect(first.peer("peer").service("other").event().read()).toEqual([]);
    expect(second.peer("peer").service("messaging").event().read()).toEqual([]);
  });
});
