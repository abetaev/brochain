import { describe, expect, it } from "vitest";
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

  it("retains events and returns immutable snapshots", () => {
    const storage = createStorage();
    const events = storage.peer("peer").service("messaging").event<string>();

    events.append("first");
    const snapshot = events.read();
    events.append("second");

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).toEqual(["first"]);
    expect(events.read()).toEqual(["first", "second"]);
  });

  it("stores and clears singleton values", () => {
    const storage = createStorage();
    const value = storage.peer("peer").service("identity").singleton<string>();

    expect(value.get()).toBeUndefined();
    value.put("current");
    expect(value.get()).toBe("current");
    value.clear();
    expect(value.get()).toBeUndefined();
  });

  it("stores and deletes key/value entries while returning immutable snapshots", () => {
    const storage = createStorage();
    const values = storage.peer("peer").service("contacts").kv<number>();

    values.put("ada", 1);
    values.put("bob", 2);
    const snapshot = values.entries();
    values.delete("ada");
    values.put("ignored", 3);

    expect(values.get("ada")).toBeUndefined();
    expect(values.get("bob")).toBe(2);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.every(Object.isFrozen)).toBe(true);
    expect(snapshot).toEqual([["ada", 1], ["bob", 2]]);
    expect(values.entries()).toEqual([["bob", 2], ["ignored", 3]]);
  });

  it("keeps storage kinds, default names, and named stores independent", () => {
    const storage = createStorage();
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
    const first = createStorage();
    const second = createStorage();
    const events = first.peer("peer").service("messaging").event<string>();

    events.append("first Session only");

    expect(first.peer("other").service("messaging").event().read()).toEqual([]);
    expect(first.peer("peer").service("other").event().read()).toEqual([]);
    expect(second.peer("peer").service("messaging").event().read()).toEqual([]);
  });
});
