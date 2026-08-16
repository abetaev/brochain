import { describe, expect, it, vi } from "vitest";
import type { Peer } from "../../common/network/index.ts";
import { createStorage } from "./storage";

function peer(id: string): Peer {
  return { id } as Peer;
}

describe("session storage", () => {
  it("returns one stable storage scope per peer identity", () => {
    const storage = createStorage();
    const firstReference = peer("peer");
    const secondReference = peer("peer");

    expect(storage.peer(firstReference)).toBe(storage.peer(firstReference));
    expect(storage.peer(secondReference)).toBe(storage.peer(firstReference));
    expect(storage.peer(peer("other-peer"))).not.toBe(storage.peer(firstReference));
  });

  it("partitions event logs without flattening their keys", () => {
    const storage = createStorage();
    const peerStorage = storage.peer(peer("peer"));
    const defaultEvents = peerStorage.events<string>("messaging");
    const namedEvents = peerStorage.events<string>("messaging", "");
    const otherService = peerStorage.events<string>("identity");
    const otherPeer = storage.peer(peer("other-peer")).events<string>("messaging");

    defaultEvents.append("default");
    namedEvents.append("named");
    otherService.append("service");
    otherPeer.append("peer");

    expect(peerStorage.events<string>("messaging")).toBe(defaultEvents);
    expect(defaultEvents.read()).toEqual(["default"]);
    expect(namedEvents.read()).toEqual(["named"]);
    expect(otherService.read()).toEqual(["service"]);
    expect(otherPeer.read()).toEqual(["peer"]);
  });

  it("keeps event and value namespaces independent and notifies after mutation", () => {
    const peerStorage = createStorage().peer(peer("peer"));
    const events = peerStorage.events<string>("service");
    const value = peerStorage.value<string>("service");
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

  it("returns immutable event snapshots and isolates Storage instances", () => {
    const remotePeer = peer("peer");
    const first = createStorage();
    const second = createStorage();
    const firstEvents = first.peer(remotePeer).events<string>("service");

    firstEvents.append("first");
    const snapshot = firstEvents.read();
    firstEvents.append("second");

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).toEqual(["first"]);
    expect(firstEvents.read()).toEqual(["first", "second"]);
    expect(second.peer(remotePeer).events<string>("service").read()).toEqual([]);
  });
});
