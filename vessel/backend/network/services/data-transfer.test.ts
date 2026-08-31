import { describe, expect, it, vi } from "vitest";
import { createData, type Peer } from "@c/backend/network";
import { createSignals } from "@v/backend/signals";
import {
  createDataTransfer,
  dataTransferServiceName,
  type DataSink,
  type DataTransferEvent,
} from "./data-transfer.ts";

function testContext(id: string) {
  return { id, signals: createSignals() };
}

function connect(
  local: ReturnType<typeof testContext>,
  remote: ReturnType<typeof testContext>,
): {
  local: ReturnType<typeof createDataTransfer>;
  remote: ReturnType<typeof createDataTransfer>;
} {
  let localService!: ReturnType<typeof createDataTransfer>;
  let remoteService!: ReturnType<typeof createDataTransfer>;
  const localPeer = peer(remote.id, () => projection(remoteService));
  const remotePeer = peer(local.id, () => projection(localService));
  localService = createDataTransfer(localPeer, local.signals);
  remoteService = createDataTransfer(remotePeer, remote.signals);
  return { local: localService, remote: remoteService };
}

function projection(service: ReturnType<typeof createDataTransfer>) {
  return {
    remote: {
      offer: async (value: Parameters<typeof service.remote.offer>[0]) =>
        await service.remote.offer(value),
      complete: async (id: string) => await service.remote.complete(id),
      cancel: async (id: string, error: string) => service.remote.cancel(id, error),
    },
    stream: service.stream,
  };
}

function peer(id: string, remote: () => object = () => ({})): Peer {
  return {
    id,
    addresses: vi.fn(() => []),
    services: vi.fn(() => [dataTransferServiceName]),
    isConnected: vi.fn(() => true),
    connect: vi.fn(),
    refreshServices: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    service: vi.fn(),
    remote: vi.fn(() => remote()),
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

async function* bytes(...chunks: readonly number[][]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield new Uint8Array(chunk);
}

describe("DataTransfer", () => {
  it("creates a complete peer-bound Network Service", () => {
    const first = createDataTransfer(peer("first"), createSignals());
    const second = createDataTransfer(peer("second"), createSignals());

    expect(first).toMatchObject({
      remote: {
        offer: expect.any(Function),
        complete: expect.any(Function),
        cancel: expect.any(Function),
      },
      stream: {
        accept: expect.any(Function),
        send: expect.any(Function),
      },
    });
    expect(first).not.toBe(second);
    expect(first.stream).not.toBe(second.stream);
  });

  it("streams accepted data with exact metadata, progress, and completion", async () => {
    const localContext = testContext("local");
    const remoteContext = testContext("remote");
    const { local, remote } = connect(localContext, remoteContext);
    const received: number[] = [];
    const localEvents: DataTransferEvent[] = [];
    const remoteEvents: DataTransferEvent[] = [];
    local.updates.subscribe((event) => localEvents.push(event));
    remote.updates.subscribe((event) => {
      remoteEvents.push(event);
      if (event.type === "offered") event.accept(Promise.resolve(sink(received)));
    });

    local.send({
      id: "transfer-1",
      size: 5,
      metadata: { kind: "test", name: "payload" },
      data: bytes([1, 2], [3, 4, 5]),
    });

    await vi.waitFor(() => {
      expect(localEvents.at(-1)?.type).toBe("completed");
      expect(remoteEvents.at(-1)?.type).toBe("completed");
    });
    expect(received).toEqual([1, 2, 3, 4, 5]);
    expect(remoteEvents[0]).toMatchObject({
      type: "offered",
      id: "transfer-1",
      peerId: "local",
      direction: "received",
      size: 5,
      metadata: { kind: "test", name: "payload" },
    });
    expect(localEvents.filter(({ type }) => type === "progress")).toEqual([
      expect.objectContaining({ transferred: 0 }),
      expect.objectContaining({ transferred: 5 }),
    ]);
  });

  it("rejects unclaimed offers on both ends", async () => {
    const localContext = testContext("local");
    const remoteContext = testContext("remote");
    const { local, remote } = connect(localContext, remoteContext);
    const localEvents: DataTransferEvent[] = [];
    const remoteEvents: DataTransferEvent[] = [];
    local.updates.subscribe((event) => localEvents.push(event));
    remote.updates.subscribe((event) => remoteEvents.push(event));

    local.send({
      id: "unclaimed",
      size: 0,
      metadata: {},
      data: bytes(),
    });

    await vi.waitFor(() => expect(localEvents.at(-1)?.type).toBe("failed"));
    expect(remoteEvents.map(({ type }) => type)).toEqual(["offered", "failed"]);
    expect(localEvents.at(-1)).toMatchObject({
      type: "failed",
      error: "No consumer accepted the incoming data transfer.",
    });
  });

  it("isolates a failed offer consumer and allows another consumer to accept", async () => {
    const localContext = testContext("local");
    const remoteContext = testContext("remote");
    const { local, remote } = connect(localContext, remoteContext);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const localEvents: DataTransferEvent[] = [];

    try {
      local.updates.subscribe((event) => localEvents.push(event));
      remote.updates.subscribe((event) => {
        if (event.type === "offered") throw new Error("Offer consumer failed.");
      });
      remote.updates.subscribe((event) => {
        if (event.type === "offered") event.accept(sink([]));
      });

      local.send({
        id: "isolated-consumer",
        size: 0,
        metadata: {},
        data: bytes(),
      });

      await vi.waitFor(() => expect(localEvents.at(-1)?.type).toBe("completed"));
      expect(logged.mock.calls).toEqual([["Channel subscriber failed."]]);
    } finally {
      logged.mockRestore();
    }
  });

  it("aborts partial data and reports failure to both ends", async () => {
    const localContext = testContext("local");
    const remoteContext = testContext("remote");
    const { local, remote } = connect(localContext, remoteContext);
    const target = sink([]);
    const localEvents: DataTransferEvent[] = [];
    const remoteEvents: DataTransferEvent[] = [];
    local.updates.subscribe((event) => localEvents.push(event));
    remote.updates.subscribe((event) => {
      remoteEvents.push(event);
      if (event.type === "offered") event.accept(target);
    });

    local.send({
      id: "partial",
      size: 2,
      metadata: {},
      data: bytes([1]),
    });

    await vi.waitFor(() => {
      expect(localEvents.at(-1)?.type).toBe("failed");
      expect(remoteEvents.at(-1)?.type).toBe("failed");
    });
    expect(target.abort).toHaveBeenCalledOnce();
    expect(localEvents.at(-1)).toMatchObject({
      error: "The data transfer source did not reach its declared size.",
    });
  });

  it("validates outgoing descriptions and limits concurrent transfers", () => {
    const never = new Promise<unknown>(() => {});
    const remote = {
      remote: {
        offer: async () => await never,
        complete: vi.fn(),
        cancel: vi.fn(async () => {}),
      },
      stream: createData(),
    };
    const transfer = createDataTransfer(peer("remote", () => remote), createSignals());

    expect(() => transfer.send({
      id: "invalid",
      size: -1,
      metadata: {},
      data: bytes(),
    })).toThrow("invalid data transfer header");
    expect(() => transfer.send({
      id: "invalid-metadata",
      size: 0,
      metadata: { missing: undefined } as never,
      data: bytes(),
    })).toThrow("JSON-compatible");

    transfer.send({ id: "one", size: 0, metadata: {}, data: bytes() });
    transfer.send({ id: "two", size: 0, metadata: {}, data: bytes() });
    expect(() => transfer.send({
      id: "three",
      size: 0,
      metadata: {},
      data: bytes(),
    })).toThrow("already has two outgoing");
  });
});
