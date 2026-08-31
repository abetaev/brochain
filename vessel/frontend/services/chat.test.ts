// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Peer } from "@c/backend/network";
import type { Network } from "@v/backend/network";
import { dataTransferServiceName } from "@v/backend/network/services/data-transfer";
import type {
  DataTransferEvent,
  OutgoingTransfer,
} from "@v/backend/network/services/data-transfer";
import type {
  MessagingEvent,
  TextMessage,
} from "@v/backend/network/services/messaging";
import { messagingServiceName } from "@v/backend/network/services/messaging";
import type { Session } from "@v/backend/session";
import { createSignals, type Channel } from "@v/backend/signals";
import {
  type FileWriter,
  type Storage,
  type StoredFile,
} from "@v/backend/storage";

import { createChat, type ChatItem } from "./chat.ts";

let messagingEvents: Channel<MessagingEvent>;
let transferEvents: Channel<DataTransferEvent>;
let messaging: {
  readonly updates: Channel<MessagingEvent>;
  send: ReturnType<typeof vi.fn>;
};
let dataTransfer: {
  readonly updates: Channel<DataTransferEvent>;
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
  const transportSignals = createSignals();
  messagingEvents = transportSignals.channel({}, "messaging");
  transferEvents = transportSignals.channel({}, "data");
  messaging = {
    updates: messagingEvents,
    send: vi.fn((message: TextMessage) => {
      messagingEvents.publish({ peerId: "remote", type: "sent", message });
    }),
  };
  dataTransfer = {
    updates: transferEvents,
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
  const signals = createSignals();
  createFile = vi.fn(async () => writer);
  const storage = createStorage(createFile);
  session = {
    username: "alice",
    network: vi.fn(() => ({
      connectedPeers: () => [remotePeer()],
      updates: signals.channel({}, "network"),
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
    service: vi.fn((name: string) => {
      if (name === messagingServiceName) return messaging;
      if (name === dataTransferServiceName) return dataTransfer;
      return undefined;
    }),
    remote: vi.fn(),
  } as unknown as Peer;
}

describe("Chat service", () => {
  it("subscribes to peer-bound services during construction", () => {
    const chat = createChat(session);
    messagingEvents.publish({
      peerId: "remote",
      type: "received",
      message: { id: "during-construction", text: "hello" },
    });
    expect(chat.history("remote")).toEqual([
      expect.objectContaining({ id: "during-construction", text: "hello" }),
    ]);
  });

  it("retains text projections before updates and owns unread state", async () => {
    const chat = await createChat(session);
    const updates: ChatItem[] = [];
    chat.updates.subscribe((item) => {
      expect(chat.history(item.peerId).find(({ id }) => id === item.id)).toBe(item);
      updates.push(item);
    });

    messagingEvents.publish({
      peerId: "remote",
      type: "received",
      message: { id: "received", text: "hello" },
    });
    expect(chat.history("remote")).toEqual([{
      id: "received",
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
    chat.sendText(remotePeer(), "preserved text");
    messagingEvents.publish({
      peerId: "remote",
      type: "failed",
      message: {
        id: "00000000-0000-4000-8000-000000000001",
        text: "preserved text",
      },
      error: "disconnected",
    });

    expect(chat.history("remote")).toHaveLength(2);
    expect(chat.history("remote")[1]).toMatchObject({
      id: "00000000-0000-4000-8000-000000000001",
      status: "failed",
      error: "disconnected",
    });
    expect(updates.at(-1)).toBe(chat.history("remote")[1]);
  });

  it("accepts incoming files into peer-scoped Storage and owns presentation", async () => {
    const chat = await createChat(session);
    let accepted: FileWriter | Promise<FileWriter> | undefined;
    transferEvents.publish({
      id: "file-1",
      peerId: "remote",
      direction: "received",
      size: 8,
      metadata: {
        kind: "chat-file",
        name: "note.txt",
        mediaType: "text/plain",
      },
      type: "offered",
      accept: (sink) => {
        accepted = sink as FileWriter | Promise<FileWriter>;
      },
      reject: vi.fn(),
    });

    await expect(Promise.resolve(accepted)).resolves.toBe(writer);
    expect(createFile).toHaveBeenCalledWith(8);
    transferEvents.publish({
      id: "file-1",
      peerId: "remote",
      direction: "received",
      size: 8,
      metadata: {
        kind: "chat-file",
        name: "note.txt",
        mediaType: "text/plain",
      },
      type: "progress",
      transferred: 4,
    });
    transferEvents.publish({
      id: "file-1",
      peerId: "remote",
      direction: "received",
      size: 8,
      metadata: {
        kind: "chat-file",
        name: "note.txt",
        mediaType: "text/plain",
      },
      type: "completed",
    });

    expect(chat.history("remote")).toHaveLength(1);
    const item = chat.history("remote")[0];
    expect(item).toMatchObject({
      kind: "file",
      name: "note.txt",
      transferred: 8,
      status: "complete",
    });
    if (item?.kind !== "file" || item.file === undefined) throw new Error("Missing file.");
    const file = await item.file.open();
    expect(file.name).toBe("note.txt");
    expect(file.type).toBe("text/plain");
    await expect(file.text()).resolves.toBe("received");
  });

  it("sends files through DataTransfer and retains progress snapshots", async () => {
    dataTransfer.send.mockImplementation((transfer: OutgoingTransfer) => {
      const base = {
        id: transfer.id,
        peerId: "remote",
        direction: "sent" as const,
        size: transfer.size,
        metadata: transfer.metadata,
      };
      transferEvents.publish({ ...base, type: "progress", transferred: transfer.size });
      transferEvents.publish({ ...base, type: "completed" });
    });
    const chat = await createChat(session);
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002");
    const file = new File(["contents"], "note.txt", { type: "text/plain" });

    chat.sendFile(remotePeer(), file);

    expect(dataTransfer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "00000000-0000-4000-8000-000000000002",
        size: file.size,
        metadata: {
          kind: "chat-file",
          name: "note.txt",
          mediaType: "text/plain",
        },
        data: expect.anything(),
      }),
    );
    expect(chat.history("remote")).toEqual([
      expect.objectContaining({
        id: "00000000-0000-4000-8000-000000000002",
        kind: "file",
        transferred: file.size,
        status: "complete",
      }),
    ]);
  });

  it("reports independent text and data-transfer capabilities", async () => {
    const chat = await createChat(session);

    expect(chat.capabilities(remotePeer())).toEqual({
      text: true,
      files: true,
    });
    expect(chat.capabilities(remotePeer(["registry", "messaging"])))
      .toEqual({ text: true, files: false });
    expect(chat.capabilities(remotePeer(["registry", "data-transfer"])))
      .toEqual({ text: false, files: true });
  });
});
