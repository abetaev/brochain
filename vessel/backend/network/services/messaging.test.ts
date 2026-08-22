import { describe, expect, it, vi } from "vitest";
import type { Network, Peer } from "@c/backend/network";
import type { Session } from "@v/backend/session";
import { createSignals } from "@v/backend/signals";
import { createStorage } from "@v/backend/storage";
import {
  createMessaging,
  messagingServiceName,
  type MessagingEvent,
} from "./messaging.ts";

type TestPeer = Peer & {
  readonly host: Peer["host"] & ReturnType<typeof vi.fn>;
  readonly service: Peer["service"] & ReturnType<typeof vi.fn>;
};

function testPeer(
  id: string,
  remote: {
    sendText(text: string): Promise<void>;
    sendFile(file: unknown): Promise<void>;
  } = {
    sendText: vi.fn(async () => {}),
    sendFile: vi.fn(async () => {}),
  },
): TestPeer {
  return {
    id,
    addresses: vi.fn(() => []),
    isConnected: vi.fn(() => true),
    connect: vi.fn(async function (this: TestPeer) {
      return this;
    }),
    subscribe: vi.fn(() => () => {}),
    host: vi.fn(),
    service: vi.fn(() => remote),
  } as unknown as TestPeer;
}

function testContext(initialPeers: readonly TestPeer[] = []) {
  const signals = createSignals();
  const storage = createStorage();
  let topology: ((peer: Peer, event: "connected" | "disconnected") => void)
    | undefined;
  const network = {
    id: "local",
    createPeer: vi.fn(),
    connectedPeers: vi.fn(() => initialPeers),
    subscribe: vi.fn((listener) => {
      topology = listener;
      return () => {};
    }),
    close: vi.fn(async () => {}),
  } as unknown as Network;
  const session = {
    username: "alice",
    network: vi.fn(async () => network),
    signals: () => signals,
    storage: () => storage,
    bootstrapError: () => undefined,
    close: vi.fn(async () => {}),
  } satisfies Session;

  return {
    session,
    storage,
    connect(peer: TestPeer) {
      topology?.(peer, "connected");
    },
  };
}

function hostedMessaging(peer: TestPeer): {
  sendText(text: string): void;
  sendFile(file: unknown): void;
} {
  const call = peer.host.mock.calls.find(([name]) => name === messagingServiceName);
  if (call === undefined) throw new Error("Messaging was not hosted.");
  return call[1];
}

describe("Messaging", () => {
  it("constructs one complete entity and wires existing and future connected peers", async () => {
    const existing = testPeer("existing");
    const connected = testPeer("connected");
    const context = testContext([existing]);
    const messaging = await createMessaging(context.session);

    expect(messaging).toEqual({
      events: expect.objectContaining({
        publish: expect.any(Function),
        subscribe: expect.any(Function),
      }),
      reads: expect.objectContaining({
        publish: expect.any(Function),
        subscribe: expect.any(Function),
      }),
      history: expect.any(Function),
      readCount: expect.any(Function),
      markRead: expect.any(Function),
      sendText: expect.any(Function),
      sendFile: expect.any(Function),
    });
    expect(existing.host).toHaveBeenCalledOnce();
    expect(existing.host).toHaveBeenCalledWith(
      messagingServiceName,
      { sendText: expect.any(Function), sendFile: expect.any(Function) },
    );

    context.connect(connected);
    context.connect(connected);
    expect(connected.host).toHaveBeenCalledOnce();
  });

  it("retains and publishes validated inbound text and files", async () => {
    const peer = testPeer("remote-peer");
    const context = testContext([peer]);
    const messaging = await createMessaging(context.session);
    const received: MessagingEvent[] = [];
    messaging.events.subscribe((event) => {
      expect(messaging.history("remote-peer").at(-1)).toBe(event);
      received.push(event);
    });
    const inbound = hostedMessaging(peer);

    inbound.sendText("  exact text  ");
    inbound.sendFile({
      name: "note.txt",
      mediaType: "text/plain",
      data: new TextEncoder().encode("contents"),
    });

    const events = messaging.history("remote-peer");
    expect(received).toEqual(events);
    expect(events[0]).toEqual({
      peerId: "remote-peer",
      type: "received",
      content: { type: "text", text: "  exact text  " },
    });
    const fileEvent = events[1];
    expect(fileEvent?.type).toBe("received");
    if (fileEvent?.type === "received" && fileEvent.content.type === "file") {
      expect(fileEvent.peerId).toBe("remote-peer");
      expect(fileEvent.content.file.name).toBe("note.txt");
      expect(fileEvent.content.file.type).toBe("text/plain");
      await expect(fileEvent.content.file.text()).resolves.toBe("contents");
    }
  });

  it("rejects invalid inbound values without retaining or publishing them", async () => {
    const peer = testPeer("remote-peer");
    const context = testContext([peer]);
    const messaging = await createMessaging(context.session);
    const listener = vi.fn();
    messaging.events.subscribe(listener);
    const inbound = hostedMessaging(peer);

    expect(() => inbound.sendText(" \n ")).toThrow("Enter a message.");
    expect(() => inbound.sendFile({
      name: "note.txt",
      mediaType: "text/plain",
      data: [],
    })).toThrow("Peer sent an invalid file.");
    expect(messaging.history("remote-peer")).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("retains before propagating subscriber failures", async () => {
    const peer = testPeer("remote-peer");
    const context = testContext([peer]);
    const messaging = await createMessaging(context.session);
    const failure = new Error("UI subscriber failed.");
    messaging.events.subscribe(() => {
      expect(messaging.history("remote-peer")).toHaveLength(1);
      throw failure;
    });

    expect(() => hostedMessaging(peer).sendText("hello")).toThrow(failure);
    expect(messaging.history("remote-peer")).toEqual([{
      peerId: "remote-peer",
      type: "received",
      content: { type: "text", text: "hello" },
    }]);
  });

  it("retains, publishes, and sends outgoing messages through the same entity", async () => {
    const remote = {
      sendText: vi.fn(async () => {}),
      sendFile: vi.fn(async () => {}),
    };
    const peer = testPeer("remote-peer", remote);
    const context = testContext([peer]);
    const messaging = await createMessaging(context.session);
    const events: MessagingEvent[] = [];
    messaging.events.subscribe((event) => events.push(event));
    const file = new File(["contents"], "note.txt", { type: "text/plain" });

    messaging.sendText(peer, "  preserved  ");
    messaging.sendFile(peer, file);
    await vi.waitFor(() => expect(remote.sendFile).toHaveBeenCalledOnce());

    expect(remote.sendText).toHaveBeenCalledWith("  preserved  ");
    expect(remote.sendFile).toHaveBeenCalledWith({
      name: "note.txt",
      mediaType: "text/plain",
      data: new TextEncoder().encode("contents"),
    });
    expect(events).toEqual(messaging.history("remote-peer"));
    expect(events).toEqual([
      {
        peerId: "remote-peer",
        type: "sent",
        content: { type: "text", text: "  preserved  " },
      },
      {
        peerId: "remote-peer",
        type: "sent",
        content: { type: "file", file },
      },
    ]);
  });

  it("records outgoing failures after the retained sent event", async () => {
    const peer = testPeer("remote-peer", {
      sendText: vi.fn(async () => {
        throw new Error("Peer disconnected.");
      }),
      sendFile: vi.fn(async () => {}),
    });
    const messaging = await createMessaging(testContext([peer]).session);

    messaging.sendText(peer, "hello");
    await vi.waitFor(() => expect(messaging.history("remote-peer")).toHaveLength(2));

    expect(messaging.history("remote-peer")).toEqual([
      {
        peerId: "remote-peer",
        type: "sent",
        content: { type: "text", text: "hello" },
      },
      {
        peerId: "remote-peer",
        type: "failed",
        error: "Peer disconnected.",
      },
    ]);
  });

  it("validates outgoing text before retaining or sending it", async () => {
    const remote = {
      sendText: vi.fn(async () => {}),
      sendFile: vi.fn(async () => {}),
    };
    const peer = testPeer("remote-peer", remote);
    const messaging = await createMessaging(testContext([peer]).session);

    expect(() => messaging.sendText(peer, "\t")).toThrow("Enter a message.");
    expect(messaging.history("remote-peer")).toEqual([]);
    expect(remote.sendText).not.toHaveBeenCalled();
  });

  it("owns read-count retention and publication", async () => {
    const peer = testPeer("remote-peer");
    const messaging = await createMessaging(testContext([peer]).session);
    const reads = vi.fn();
    messaging.reads.subscribe(reads);
    const inbound = hostedMessaging(peer);
    inbound.sendText("first");
    inbound.sendText("second");

    messaging.markRead("remote-peer");

    expect(messaging.readCount("remote-peer")).toBe(2);
    expect(reads).toHaveBeenCalledOnce();
    expect(reads).toHaveBeenCalledWith({ peerId: "remote-peer", count: 2 });
  });

  it("isolates independent Session entities", async () => {
    const firstPeer = testPeer("remote-peer");
    const secondPeer = testPeer("remote-peer");
    const first = await createMessaging(testContext([firstPeer]).session);
    const second = await createMessaging(testContext([secondPeer]).session);

    hostedMessaging(firstPeer).sendText("first only");

    expect(first.history("remote-peer")).toHaveLength(1);
    expect(second.history("remote-peer")).toEqual([]);
  });
});
