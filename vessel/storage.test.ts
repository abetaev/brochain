import { describe, expect, it, vi } from "vitest";
import { createStorage } from "./storage";

describe("session storage", () => {
  it("partitions event logs without flattening their keys", () => {
    const storage = createStorage();
    const defaultEvents = storage.events<string>("peer", "messaging");
    const namedEvents = storage.events<string>("peer", "messaging", "");
    const otherService = storage.events<string>("peer", "identity");
    const otherPeer = storage.events<string>("other-peer", "messaging");

    defaultEvents.append("default");
    namedEvents.append("named");
    otherService.append("service");
    otherPeer.append("peer");

    expect(storage.events<string>("peer", "messaging")).toBe(defaultEvents);
    expect(defaultEvents.read()).toEqual(["default"]);
    expect(namedEvents.read()).toEqual(["named"]);
    expect(otherService.read()).toEqual(["service"]);
    expect(otherPeer.read()).toEqual(["peer"]);
  });

  it("keeps event and value namespaces independent and notifies after mutation", () => {
    const storage = createStorage();
    const events = storage.events<string>("peer", "service");
    const value = storage.value<string>("peer", "service");
    const eventListener = vi.fn((event: string) => {
      expect(events.read()).toEqual([event]);
    });
    const valueListener = vi.fn((next: string) => {
      expect(value.get()).toBe(next);
    });

    const unsubscribeEvent = events.subscribe(eventListener);
    const unsubscribeValue = value.subscribe(valueListener);
    events.append("event");
    value.put("value");
    unsubscribeEvent();
    unsubscribeValue();
    events.append("ignored event");
    value.put("ignored value");

    expect(eventListener).toHaveBeenCalledOnce();
    expect(valueListener).toHaveBeenCalledOnce();
    expect(events.read()).toEqual(["event", "ignored event"]);
    expect(value.get()).toBe("ignored value");
  });

  it("returns immutable event snapshots and isolates factory instances", () => {
    const first = createStorage();
    const second = createStorage();
    const firstEvents = first.events<string>("peer", "service");

    firstEvents.append("first");
    const snapshot = firstEvents.read();
    firstEvents.append("second");

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).toEqual(["first"]);
    expect(firstEvents.read()).toEqual(["first", "second"]);
    expect(second.events<string>("peer", "service").read()).toEqual([]);
  });
});
