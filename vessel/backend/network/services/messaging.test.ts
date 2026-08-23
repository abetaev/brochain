import { describe, expect, it, vi } from "vitest";
import type { Network, Peer, Services } from "@c/backend/network";
import type { Session } from "@v/backend/session";
import { createSignals } from "@v/backend/signals";
import { createStorage } from "@v/backend/storage";
import {
  createMessaging,
  messagingServiceName,
  type MessagingEvent,
  type TextMessage,
} from "./messaging.ts";

interface MessagingRpc {
  send(message: TextMessage): void;
}

function testPeer(
  id: string,
  remote: MessagingRpc = { send: vi.fn() },
): Peer {
  return {
    id,
    addresses: vi.fn(() => []),
    isConnected: vi.fn(() => true),
    connect: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    service: vi.fn(() => remote),
    open: vi.fn(),
  } as unknown as Peer;
}

function testContext() {
  const signals = createSignals();
  let provided: Services = {};
  const network = {
    id: "local",
    provide: vi.fn(async (services: Services) => {
      provided = { ...provided, ...services };
    }),
  } as unknown as Network;
  const session = {
    username: "alice",
    network: vi.fn(async () => network),
    signals: () => signals,
    storage: () => createStorage(),
    dataStorage: vi.fn(),
    bootstrapError: () => undefined,
    close: vi.fn(),
  } as unknown as Session;

  return {
    session,
    network,
    inbound(peer: Peer): MessagingRpc {
      const rpc = provided[messagingServiceName]?.rpc;
      if (rpc === undefined) throw new Error("Messaging RPC was not provided.");
      return rpc(peer, network) as MessagingRpc;
    },
  };
}

describe("Messaging", () => {
  it("constructs one text transport and provides its RPC facet", async () => {
    const context = testContext();
    const messaging = await createMessaging(context.session);

    expect(messaging).toEqual({
      events: expect.objectContaining({
        publish: expect.any(Function),
        subscribe: expect.any(Function),
      }),
      send: expect.any(Function),
    });
    expect(context.network.provide).toHaveBeenCalledWith({
      [messagingServiceName]: { rpc: expect.any(Function) },
    });
  });

  it("publishes exact validated peer-tagged inbound messages", async () => {
    const context = testContext();
    const messaging = await createMessaging(context.session);
    const events: MessagingEvent[] = [];
    messaging.events.subscribe((event) => events.push(event));
    const inbound = context.inbound(testPeer("remote-peer"));

    inbound.send({ id: "message-1", text: "  exact text  " });

    expect(events).toEqual([{
      peerId: "remote-peer",
      type: "received",
      message: { id: "message-1", text: "  exact text  " },
    }]);
    expect(() => inbound.send({ id: "", text: "invalid" })).toThrow("invalid text");
    expect(() => inbound.send({ id: "message-2", text: " \n " })).toThrow("invalid text");
    expect(events).toHaveLength(1);
  });

  it("isolates subscriber failures from inbound RPC and other consumers", async () => {
    const context = testContext();
    const messaging = await createMessaging(context.session);
    const failure = new Error("Chat subscriber failed.");
    const later = vi.fn();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      messaging.events.subscribe(() => {
        throw failure;
      });
      messaging.events.subscribe(later);

      expect(() => context.inbound(testPeer("remote")).send({
        id: "message",
        text: "hello",
      })).not.toThrow();
      expect(later).toHaveBeenCalledWith({
        peerId: "remote",
        type: "received",
        message: { id: "message", text: "hello" },
      });
      expect(logged).toHaveBeenCalledWith("Signals subscriber failed.", failure);
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
    const messaging = await createMessaging(testContext().session);
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

  it("isolates channels between Session entities", async () => {
    const firstContext = testContext();
    const secondContext = testContext();
    const first = await createMessaging(firstContext.session);
    const second = await createMessaging(secondContext.session);
    const firstEvents = vi.fn();
    const secondEvents = vi.fn();
    first.events.subscribe(firstEvents);
    second.events.subscribe(secondEvents);

    firstContext.inbound(testPeer("remote")).send({ id: "one", text: "first" });

    expect(firstEvents).toHaveBeenCalledOnce();
    expect(secondEvents).not.toHaveBeenCalled();
  });
});
