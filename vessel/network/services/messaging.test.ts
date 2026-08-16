import { describe, expect, it, vi } from "vitest";
import type { Peer, RemoteService } from "../../../common/network/index.ts";
import { createStorage, type Storage } from "../../services/storage.ts";
import {
  createMessaging,
  type MessagingEvent,
  type MessagingService,
} from "./messaging.ts";

function peer(id: string): Peer {
  return { id } as Peer;
}

function remote(value: object): RemoteService<MessagingService> {
  return value as RemoteService<MessagingService>;
}

function snapshotsOf(storage: Storage, remotePeer: Peer) {
  const events = storage.peer(remotePeer).events<MessagingEvent>("messaging");
  const snapshots: Array<readonly MessagingEvent[]> = [events.read()];
  events.subscribe(() => snapshots.push(events.read()));
  return snapshots;
}

describe("Messaging", () => {
  it("defines a messaging service and retains inbound text and files in order", async () => {
    const storage = createStorage();
    const messaging = createMessaging(storage);
    const remotePeer = peer("peer");
    const incoming = messaging.serve(remotePeer);

    expect(messaging.name).toBe("messaging");
    incoming.sendText("  exact text  ");
    incoming.sendFile({
      name: "note.txt",
      mediaType: "text/plain",
      data: new TextEncoder().encode("contents"),
    });

    const events = storage.peer(remotePeer).events<MessagingEvent>("messaging").read();
    expect(events.map(({ type }) => type)).toEqual(["received", "received"]);
    expect(events[0]).toEqual({
      type: "received",
      content: { type: "text", text: "  exact text  " },
    });
    const fileEvent = events[1];
    expect(fileEvent?.type).toBe("received");
    if (fileEvent?.type === "received" && fileEvent.content.type === "file") {
      expect(fileEvent.content.file.name).toBe("note.txt");
      expect(fileEvent.content.file.type).toBe("text/plain");
      await expect(fileEvent.content.file.text()).resolves.toBe("contents");
    }
    expect(Object.isFrozen(events)).toBe(true);
  });

  it("appends outgoing messages immediately and delivers them in order", async () => {
    let releaseText!: () => void;
    let releaseFile!: () => void;
    const textDelivery = new Promise<void>((resolve) => { releaseText = resolve; });
    const fileDelivery = new Promise<void>((resolve) => { releaseFile = resolve; });
    const rpc = {
      sendText: vi.fn(async (_text: string) => await textDelivery),
      sendFile: vi.fn(async (_file: unknown) => await fileDelivery),
    };
    const remotePeer = peer("peer");
    const storage = createStorage();
    const messaging = createMessaging(storage);
    const gateway = messaging.gateway(remotePeer, remote(rpc));
    const snapshots = snapshotsOf(storage, remotePeer);

    gateway.sendText("hello");
    gateway.sendFile(new File(["contents"], "note.txt", { type: "text/plain" }));

    expect(snapshots.at(-1)?.map(({ type }) => type)).toEqual(["sent", "sent"]);
    await vi.waitFor(() => expect(rpc.sendText).toHaveBeenCalledWith("hello"));
    expect(rpc.sendFile).not.toHaveBeenCalled();

    releaseText();
    await vi.waitFor(() => expect(rpc.sendFile).toHaveBeenCalledOnce());
    const sentFile = rpc.sendFile.mock.calls[0]?.[0] as {
      name: string;
      mediaType: string;
      data: Uint8Array;
    };
    expect({ ...sentFile, data: [...sentFile.data] }).toEqual({
      name: "note.txt",
      mediaType: "text/plain",
      data: [...new TextEncoder().encode("contents")],
    });
    releaseFile();
  });

  it("shares delivery ordering between separately requested gateways", async () => {
    let release!: () => void;
    const firstDelivery = new Promise<void>((resolve) => { release = resolve; });
    const rpc = {
      sendText: vi.fn()
        .mockImplementationOnce(async () => await firstDelivery)
        .mockResolvedValue(undefined),
      sendFile: vi.fn(),
    };
    const remotePeer = peer("peer");
    const messaging = createMessaging(createStorage());
    const first = messaging.gateway(remotePeer, remote(rpc));
    const second = messaging.gateway(remotePeer, remote(rpc));

    first.sendText("first");
    second.sendText("second");

    await vi.waitFor(() => expect(rpc.sendText).toHaveBeenCalledTimes(1));
    release();
    await vi.waitFor(() => expect(rpc.sendText).toHaveBeenCalledTimes(2));
    expect(rpc.sendText.mock.calls).toEqual([["first"], ["second"]]);
  });

  it("records asynchronous delivery failures without hiding the sent message", async () => {
    const rpc = {
      sendText: vi.fn(async (_text: string) => {
        throw new Error("Peer disconnected.");
      }),
      sendFile: vi.fn(),
    };
    const remotePeer = peer("peer");
    const storage = createStorage();
    const gateway = createMessaging(storage).gateway(remotePeer, remote(rpc));
    const snapshots = snapshotsOf(storage, remotePeer);

    gateway.sendText("still visible");
    expect(snapshots.at(-1)).toHaveLength(1);
    await vi.waitFor(() => expect(snapshots.at(-1)).toHaveLength(2));
    expect(snapshots.at(-1)).toEqual([
      { type: "sent", content: { type: "text", text: "still visible" } },
      { type: "failed", error: "Peer disconnected." },
    ]);
  });

  it("preserves non-empty whitespace and rejects whitespace-only text", async () => {
    const rpc = {
      sendText: vi.fn(async (_text: string) => {}),
      sendFile: vi.fn(),
    };
    const remotePeer = peer("peer");
    const messaging = createMessaging(createStorage());
    const gateway = messaging.gateway(remotePeer, remote(rpc));

    expect(() => gateway.sendText(" \n ")).toThrow("Enter a message.");
    expect(() => messaging.serve(remotePeer).sendText("\t")).toThrow("Enter a message.");
    gateway.sendText("  preserved  ");

    await vi.waitFor(() => {
      expect(rpc.sendText).toHaveBeenCalledWith("  preserved  ");
    });
  });

  it("rejects malformed incoming files without recording them", () => {
    const storage = createStorage();
    const remotePeer = peer("peer");
    const incoming = createMessaging(storage).serve(remotePeer);

    expect(() => incoming.sendFile({
      name: "note.txt",
      mediaType: "text/plain",
      data: [],
    } as unknown as Parameters<typeof incoming.sendFile>[0])).toThrow(
      "Peer sent an invalid file.",
    );
    expect(storage.peer(remotePeer).events("messaging").read()).toEqual([]);
  });

  it("isolates providers backed by independent Session storage", () => {
    const remotePeer = peer("peer");
    const firstStorage = createStorage();
    const secondStorage = createStorage();
    const first = createMessaging(firstStorage);
    const second = createMessaging(secondStorage);

    first.serve(remotePeer).sendText("first only");

    expect(firstStorage.peer(remotePeer).events("messaging").read()).toHaveLength(1);
    expect(secondStorage.peer(remotePeer).events("messaging").read()).toEqual([]);
    expect(second.name).toBe("messaging");
  });
});
