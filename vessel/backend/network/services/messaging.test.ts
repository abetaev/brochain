import { describe, expect, it, vi } from "vitest";
import type { Peer } from "@c/backend/network";
import { createSignals } from "@v/backend/signals";
import {
  createMessaging,
  type MessagingEvent,
} from "./messaging.ts";

function testPeer(
  id: string,
  remote = { send: vi.fn() },
): Peer {
  return {
    id,
    addresses: vi.fn(() => []),
    services: vi.fn(() => ["messaging"]),
    isConnected: vi.fn(() => true),
    connect: vi.fn(),
    refreshServices: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    service: vi.fn(),
    remote: vi.fn(() => ({ remote })),
  } as unknown as Peer;
}

describe("Messaging", () => {
  it("creates a separate peer-bound RPC service", () => {
    const first = createMessaging(testPeer("first"), createSignals());
    const second = createMessaging(testPeer("second"), createSignals());

    expect(first).not.toBe(second);
  });

  it("publishes exact validated peer-tagged inbound messages", () => {
    const messaging = createMessaging(testPeer("remote-peer"), createSignals());
    const events: MessagingEvent[] = [];
    messaging.updates.subscribe((event) => events.push(event));

    messaging.remote.send({ id: "message-1", text: "  exact text  " });

    expect(events).toEqual([{
      peerId: "remote-peer",
      type: "received",
      message: { id: "message-1", text: "  exact text  " },
    }]);
    expect(() => messaging.remote.send({ id: "", text: "invalid" })).toThrow("invalid text");
    expect(() => messaging.remote.send({ id: "message-2", text: " \n " })).toThrow("invalid text");
    expect(events).toHaveLength(1);
  });

  it("isolates subscriber failures from inbound RPC and other consumers", () => {
    const messaging = createMessaging(testPeer("remote"), createSignals());
    const later = vi.fn();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      messaging.updates.subscribe(() => {
        throw new Error("Chat subscriber failed.");
      });
      messaging.updates.subscribe(later);

      expect(() => messaging.remote.send({
        id: "message",
        text: "hello",
      })).not.toThrow();
      expect(later).toHaveBeenCalledWith({
        peerId: "remote",
        type: "received",
        message: { id: "message", text: "hello" },
      });
      expect(logged.mock.calls).toEqual([["Channel subscriber failed."]]);
    } finally {
      logged.mockRestore();
    }
  });

  it("publishes outgoing text immediately and reports remote failure", async () => {
    const remote = {
      send: vi.fn(async () => {
        throw new Error("Peer disconnected.");
      }),
    };
    const peer = testPeer("remote-peer", remote);
    const messaging = createMessaging(peer, createSignals());
    const events: MessagingEvent[] = [];
    messaging.updates.subscribe((event) => events.push(event));

    messaging.send({ id: "message-1", text: "hello" });
    expect(events).toEqual([{
      peerId: "remote-peer",
      type: "sent",
      message: { id: "message-1", text: "hello" },
    }]);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(remote.send).toHaveBeenCalledWith({ id: "message-1", text: "hello" });
    expect(events[1]).toEqual({
      peerId: "remote-peer",
      type: "failed",
      message: { id: "message-1", text: "hello" },
      error: "Peer disconnected.",
    });
  });

  it("isolates channels between Network entities", () => {
    const first = createMessaging(testPeer("first"), createSignals());
    const second = createMessaging(testPeer("second"), createSignals());
    const firstEvents = vi.fn();
    const secondEvents = vi.fn();
    first.updates.subscribe(firstEvents);
    second.updates.subscribe(secondEvents);

    first.remote.send({ id: "one", text: "first" });

    expect(firstEvents).toHaveBeenCalledOnce();
    expect(secondEvents).not.toHaveBeenCalled();
  });
});
