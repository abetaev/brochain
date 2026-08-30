import { describe, expect, it, vi } from "vitest";
import type { Network, Peer } from "@c/backend/network";
import { createSignals } from "@v/backend/signals";
import {
  createMessaging,
  type Messaging,
  type MessagingEvent,
  type TextMessage,
} from "./messaging.ts";

interface MessagingRpc {
  send(message: TextMessage): void;
}

function testPeer(id: string, remote: MessagingRpc = { send: vi.fn() }): Peer {
  return {
    id,
    addresses: vi.fn(() => []),
    services: vi.fn(() => ["messaging"]),
    isConnected: vi.fn(() => true),
    connect: vi.fn(),
    refreshServices: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    service: vi.fn(() => remote),
    open: vi.fn(),
  } as unknown as Peer;
}

function inbound(messaging: Messaging, peer: Peer): MessagingRpc {
  const rpc = messaging.factory(peer, {} as Network).rpc;
  if (rpc === undefined) throw new Error("Messaging did not create its RPC facet.");
  return rpc as MessagingRpc;
}

describe("Messaging", () => {
  it("creates a separate peer-bound RPC service", () => {
    const messaging = createMessaging(createSignals());
    const first = inbound(messaging, testPeer("first"));
    const second = inbound(messaging, testPeer("second"));

    expect(first).not.toBe(second);
  });

  it("publishes exact validated peer-tagged inbound messages", () => {
    const messaging = createMessaging(createSignals());
    const events: MessagingEvent[] = [];
    messaging.events.subscribe((event) => events.push(event));
    const receive = inbound(messaging, testPeer("remote-peer"));

    receive.send({ id: "message-1", text: "  exact text  " });

    expect(events).toEqual([{
      peerId: "remote-peer",
      type: "received",
      message: { id: "message-1", text: "  exact text  " },
    }]);
    expect(() => receive.send({ id: "", text: "invalid" })).toThrow("invalid text");
    expect(() => receive.send({ id: "message-2", text: " \n " })).toThrow("invalid text");
    expect(events).toHaveLength(1);
  });

  it("isolates subscriber failures from inbound RPC and other consumers", () => {
    const messaging = createMessaging(createSignals());
    const later = vi.fn();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      messaging.events.subscribe(() => {
        throw new Error("Chat subscriber failed.");
      });
      messaging.events.subscribe(later);

      expect(() => inbound(messaging, testPeer("remote")).send({
        id: "message",
        text: "hello",
      })).not.toThrow();
      expect(later).toHaveBeenCalledWith({
        peerId: "remote",
        type: "received",
        message: { id: "message", text: "hello" },
      });
      expect(logged.mock.calls).toEqual([["Signals subscriber failed."]]);
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
    const messaging = createMessaging(createSignals());
    const events: MessagingEvent[] = [];
    messaging.events.subscribe((event) => events.push(event));

    messaging.send(peer, { id: "message-1", text: "hello" });
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
    const first = createMessaging(createSignals());
    const second = createMessaging(createSignals());
    const firstEvents = vi.fn();
    const secondEvents = vi.fn();
    first.events.subscribe(firstEvents);
    second.events.subscribe(secondEvents);

    inbound(first, testPeer("remote")).send({ id: "one", text: "first" });

    expect(firstEvents).toHaveBeenCalledOnce();
    expect(secondEvents).not.toHaveBeenCalled();
  });
});
