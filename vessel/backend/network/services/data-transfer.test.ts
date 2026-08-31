import { describe, expect, it, vi } from "vitest";
import type { Peer } from "@c/backend/network";
import {
  createDataTransfer,
  dataTransferServiceName,
  type DataSink,
  type DataTransferEvent,
} from "./data-transfer.ts";

type Service = ReturnType<typeof createDataTransfer>;

function connect(): { local: Service; remote: Service } {
  let local!: Service;
  let remote!: Service;
  local = createDataTransfer(peer(() => remote));
  remote = createDataTransfer(peer(() => local));
  return { local, remote };
}

function peer(counterpart: () => Service): Peer {
  return {
    id: "remote",
    addresses: vi.fn(() => []),
    services: vi.fn(() => [dataTransferServiceName]),
    isConnected: vi.fn(() => true),
    connect: vi.fn(),
    refreshServices: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    hosts: vi.fn(() => true),
    service: vi.fn(() => ({
      remote: { offer: async (header: never) => await counterpart().remote.offer(header) },
      data: counterpart().data,
    })),
  } as unknown as Peer;
}

function sink(contents: number[]): DataSink {
  return {
    write: vi.fn(async (data: Uint8Array) => {
      contents.push(...data);
    }),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
}

function accepting(service: Service, received: DataTransferEvent[], target: DataSink) {
  service.events.subscribe((event) => {
    received.push(event);
    if (event.type === "offered") event.accept(target);
  });
}

async function* bytes(...chunks: readonly number[][]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield new Uint8Array(chunk);
}

describe("DataTransfer", () => {
  it("delivers declared-length content and reports completion to both ends", async () => {
    const { local, remote } = connect();
    const contents: number[] = [];
    const sent: DataTransferEvent[] = [];
    const received: DataTransferEvent[] = [];
    local.events.subscribe((event) => sent.push(event));
    accepting(remote, received, sink(contents));

    local.send({
      id: "transfer-1",
      size: 4,
      metadata: { kind: "chat-file", name: "note.txt" },
      data: bytes([1, 2], [3, 4]),
    });

    await vi.waitFor(() => {
      expect(sent.at(-1)?.type).toBe("completed");
      expect(received.at(-1)?.type).toBe("completed");
    });
    expect(contents).toEqual([1, 2, 3, 4]);
    expect(received[0]).toMatchObject({
      type: "offered",
      direction: "received",
      size: 4,
      metadata: { kind: "chat-file", name: "note.txt" },
    });
    expect(sent.at(-1)).toMatchObject({ id: "transfer-1", direction: "sent" });
  });

  it("delivers content whose length is not known in advance", async () => {
    const { local, remote } = connect();
    const contents: number[] = [];
    const received: DataTransferEvent[] = [];
    const sent: DataTransferEvent[] = [];
    local.events.subscribe((event) => sent.push(event));
    accepting(remote, received, sink(contents));

    local.send({ id: "capture", metadata: { kind: "capture" }, data: bytes([7], [8, 9]) });

    await vi.waitFor(() => expect(sent.at(-1)?.type).toBe("completed"));
    expect(contents).toEqual([7, 8, 9]);
    expect(received[0]).toMatchObject({ type: "offered" });
    expect(received[0]).not.toHaveProperty("size");
  });

  it("fails a transfer no receiver claims", async () => {
    const { local, remote } = connect();
    const sent: DataTransferEvent[] = [];
    local.events.subscribe((event) => sent.push(event));
    remote.events.subscribe((event) => {
      if (event.type === "offered") event.reject("Not interested.");
    });

    local.send({ id: "unclaimed", size: 1, metadata: {}, data: bytes([1]) });

    await vi.waitFor(() =>
      expect(sent.at(-1)).toMatchObject({ type: "failed", error: "Not interested." })
    );
  });

  it("reports a failing sink to both ends and aborts it", async () => {
    const { local, remote } = connect();
    const sent: DataTransferEvent[] = [];
    const received: DataTransferEvent[] = [];
    const failing: DataSink = {
      write: vi.fn(async () => {
        throw new Error("Storage is full.");
      }),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };
    local.events.subscribe((event) => sent.push(event));
    accepting(remote, received, failing);

    local.send({ id: "failing", size: 2, metadata: {}, data: bytes([1, 2]) });

    await vi.waitFor(() => {
      expect(sent.at(-1)?.type).toBe("failed");
      expect(received.at(-1)).toMatchObject({ type: "failed", error: "Storage is full." });
    });
    expect(failing.abort).toHaveBeenCalled();
  });

  it("rejects a reused identifier and refuses unoffered content", async () => {
    const { remote } = connect();
    const contents: number[] = [];
    const received: DataTransferEvent[] = [];
    accepting(remote, received, sink(contents));

    await expect(remote.remote.offer({ id: "once", size: 1, metadata: {} }))
      .resolves.toEqual({ accepted: true });
    await expect(remote.remote.offer({ id: "once", size: 1, metadata: {} }))
      .resolves.toMatchObject({ accepted: false });
    await expect(remote.remote.offer({ id: "", size: 1, metadata: {} }))
      .rejects.toThrow("invalid data transfer offer");

    const stray = remote.data.send(bytes([1]), { id: "never-offered", size: 1 });
    await expect(stray.completion).rejects.toThrow("never offered");
  });
});
