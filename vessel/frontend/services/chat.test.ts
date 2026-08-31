// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Peer } from "@c/backend/network";
import type { Network } from "@v/backend/network";
import { dataTransferServiceName } from "@v/backend/network/services/data-transfer";
import type {
  DataTransferEvent,
  OutgoingTransfer,
} from "@v/backend/network/services/data-transfer";
import type { ReceivedMessage } from "@v/backend/network/services/messaging";
import { messagingServiceName } from "@v/backend/network/services/messaging";
import type { Session } from "@v/backend/session";
import signals, { type Channel } from "@c/backend/signals";
import {
  type FileWriter,
  type Storage,
  type StoredFile,
} from "@v/backend/storage";

import { createChat, type ChatItem } from "./chat.ts";

let messagingEvents: Channel<ReceivedMessage>;
let transferEvents: Channel<DataTransferEvent>;
let messaging: {
  readonly events: Channel<ReceivedMessage>;
  readonly remote: { send: ReturnType<typeof vi.fn> };
};
let dataTransfer: {
  readonly events: Channel<DataTransferEvent>;
  send: ReturnType<typeof vi.fn>;
};
let writer: FileWriter;
let createFile: ReturnType<typeof vi.fn>;
let session: Session;

function createStorage(createFile: ReturnType<typeof vi.fn>): Storage {
  const events: unknown[] = [];
  const values = new Map<string, unknown>();
  let singleton: unknown;
  const service = {
    event: () => ({
      append: (event: unknown) => events.push(event),
      read: () => Object.freeze([...events]),
    }),
    singleton: () => ({
      get: () => singleton,
      put: (value: unknown) => {
        singleton = value;
      },
      clear: () => {
        singleton = undefined;
      },
    }),
    kv: () => ({
      get: (key: string) => values.get(key),
      put: (key: string, value: unknown) => values.set(key, value),
      delete: (key: string) => values.delete(key),
      entries: () => Object.freeze([...values.entries()]),
    }),
    fs: () => ({ create: createFile }),
  };
  const peer = { service: () => service };
  return {
    peer: () => peer,
    close: vi.fn(async () => {}),
  } as unknown as Storage;
}

beforeEach(() => {
  messagingEvents = signals.channel();
  transferEvents = signals.channel();
  messaging = {
    events: messagingEvents,
    remote: { send: vi.fn(async () => {}) },
  };
  dataTransfer = {
    events: transferEvents,
    send: vi.fn<(transfer: OutgoingTransfer) => void>(),
  };
  const stored: StoredFile = {
    blob: vi.fn(async () => new Blob(["received"])),
    remove: vi.fn(async () => {}),
  };
  writer = {
    file: stored,
    write: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
    createFile = vi.fn(async () => writer);
  const storage = createStorage(createFile);
  session = {
    username: "alice",
    network: vi.fn(() => ({
      connectedPeers: () => [remotePeer()],
      updates: signals.channel(),
    } as unknown as Network)),
    signals: () => signals,
    storage: () => storage,
    close: vi.fn(),
  } as unknown as Session;
});

function remotePeer(services = ["registry", "messaging", "data-transfer"]): Peer {
  return {
    id: "remote",
    addresses: vi.fn(() => []),
    services: vi.fn(() => services),
    isConnected: vi.fn(() => true),
    connect: vi.fn(),
    refreshServices: vi.fn(async () => services),
    subscribe: vi.fn(() => () => {}),
    hosts: vi.fn((name: string) => services.includes(name)),
    service: vi.fn((name: string) => {
      if (name === messagingServiceName) return messaging;
      if (name === dataTransferServiceName) return dataTransfer;
      return undefined;
    }),
  } as unknown as Peer;
}

describe("Chat service", () => {

  it("retains text projections before updates and owns unread state", async () => {
    const chat = await createChat(session);
    const updates: ChatItem[] = [];
    chat.updates.subscribe((item) => {
      expect(chat.history(item.peerId).find(({ id }) => id === item.id)).toBe(item);
      updates.push(item);
    });

    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000000");
    messagingEvents.publish({ message: "hello" });
    expect(chat.history("remote")).toEqual([{
      id: "00000000-0000-4000-8000-000000000000",
      peerId: "remote",
      direction: "received",
      kind: "text",
      text: "hello",
      status: "complete",
    }]);
    expect(chat.readCount("remote")).toBe(0);

    const reads = vi.fn();
    chat.reads.subscribe(reads);
    chat.markRead("remote");
    expect(chat.readCount("remote")).toBe(1);
    expect(reads).toHaveBeenCalledWith({ peerId: "remote", count: 1 });

    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001");
    messaging.remote.send.mockRejectedValueOnce(new Error("disconnected"));
    chat.sendText(remotePeer(), "preserved text");
    await vi.waitFor(() =>
      expect(chat.history("remote")[1]).toMatchObject({
        id: "00000000-0000-4000-8000-000000000001",
        text: "preserved text",
        status: "failed",
        error: "disconnected",
      })
    );
    expect(chat.history("remote")).toHaveLength(2);
    expect(updates.at(-1)).toBe(chat.history("remote")[1]);
  });



});
