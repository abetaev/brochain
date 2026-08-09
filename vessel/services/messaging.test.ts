import { describe, expect, it, vi } from "vitest";
import type { Peer } from "../../common/network.ts";
import { createStorage } from "../storage";
import { createMessaging, type MessagingEvent } from "./messaging";

function peer(id: string, remote: object): Peer {
  return { id, service: () => remote } as unknown as Peer;
}

function snapshotsOf(messaging: ReturnType<typeof createMessaging>, remotePeer: Peer) {
  const snapshots: Array<readonly MessagingEvent[]> = [];
  messaging.instance(remotePeer).subscribe((events) => snapshots.push(events));
  return snapshots;
}

describe("Messaging", () => {
  it("retains inbound text and files in order and replays their snapshot", async () => {
    const messaging = createMessaging(createStorage());
    const remotePeer = peer("peer", {});
    const incoming = messaging.serve(remotePeer);

    incoming.sendText("  exact text  ");
    incoming.sendFile({
      name: "note.txt",
      mediaType: "text/plain",
      data: new TextEncoder().encode("contents"),
    });

    const snapshots = snapshotsOf(messaging, remotePeer);
    const events = snapshots.at(-1);
    expect(events?.map(({ type }) => type)).toEqual(["received", "received"]);
    expect(events?.[0]).toEqual({
      type: "received",
      content: { type: "text", text: "  exact text  " },
    });
    const fileEvent = events?.[1];
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
    const remote = {
      sendText: vi.fn(async (_text: string) => await textDelivery),
      sendFile: vi.fn(async (_file: unknown) => await fileDelivery),
    };
    const remotePeer = peer("peer", remote);
    const messaging = createMessaging(createStorage());
    const instance = messaging.instance(remotePeer);
    const snapshots: Array<readonly MessagingEvent[]> = [];
    instance.subscribe((events) => snapshots.push(events));

    instance.sendText("hello");
    instance.sendFile(new File(["contents"], "note.txt", { type: "text/plain" }));

    expect(snapshots.at(-1)?.map(({ type }) => type)).toEqual(["sent", "sent"]);
    await vi.waitFor(() => expect(remote.sendText).toHaveBeenCalledWith("hello"));
    expect(remote.sendFile).not.toHaveBeenCalled();

    releaseText();
    await vi.waitFor(() => expect(remote.sendFile).toHaveBeenCalledOnce());
    const sentFile = remote.sendFile.mock.calls[0]?.[0] as {
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

  it("records asynchronous delivery failures without hiding the sent message", async () => {
    const remote = {
      sendText: vi.fn(async (_text: string) => {
        throw new Error("Peer disconnected.");
      }),
    };
    const remotePeer = peer("peer", remote);
    const messaging = createMessaging(createStorage());
    const instance = messaging.instance(remotePeer);
    const snapshots: Array<readonly MessagingEvent[]> = [];
    instance.subscribe((events) => snapshots.push(events));

    instance.sendText("still visible");
    expect(snapshots.at(-1)).toHaveLength(1);
    await vi.waitFor(() => expect(snapshots.at(-1)).toHaveLength(2));
    expect(snapshots.at(-1)).toEqual([
      { type: "sent", content: { type: "text", text: "still visible" } },
      { type: "failed", error: "Peer disconnected." },
    ]);
  });

  it("preserves non-empty whitespace and rejects whitespace-only text", async () => {
    const remote = { sendText: vi.fn(async (_text: string) => {}) };
    const remotePeer = peer("peer", remote);
    const messaging = createMessaging(createStorage());
    const instance = messaging.instance(remotePeer);

    expect(() => instance.sendText(" \n ")).toThrow("Enter a message.");
    expect(() => messaging.serve(remotePeer).sendText("\t")).toThrow("Enter a message.");
    instance.sendText("  preserved  ");

    await vi.waitFor(() => {
      expect(remote.sendText).toHaveBeenCalledWith("  preserved  ");
    });
  });

  it("isolates providers backed by independent Session storage", () => {
    const remotePeer = peer("peer", {});
    const first = createMessaging(createStorage());
    const second = createMessaging(createStorage());

    first.serve(remotePeer).sendText("first only");

    expect(snapshotsOf(first, remotePeer).at(-1)).toHaveLength(1);
    expect(snapshotsOf(second, remotePeer).at(-1)).toEqual([]);
  });
});
