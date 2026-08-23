import { describe, expect, it, vi } from "vitest";
import type { ByteStream, Network, Peer, Services } from "@c/backend/network";
import type { Session } from "@v/backend/session";
import { createSignals } from "@v/backend/signals";
import { createStorage as createStorageRoot } from "@v/backend/storage";
import {
  createDataTransfer,
  dataTransferProtocol,
  dataTransferServiceName,
  type DataSink,
  type DataTransferEvent,
} from "./data-transfer.ts";

interface Pipe {
  readonly values: Uint8Array[];
  readonly readers: Array<{
    resolve(value: IteratorResult<Uint8Array>): void;
    reject(reason: unknown): void;
  }>;
  closed: boolean;
  error?: Error;
}

function createStorage() {
  return createStorageRoot("test-account");
}

function createPipe(): Pipe {
  return { values: [], readers: [], closed: false };
}

function streamPair(): readonly [ByteStream, ByteStream] {
  const first = createPipe();
  const second = createPipe();
  return [stream(first, second), stream(second, first)];
}

function stream(incoming: Pipe, outgoing: Pipe): ByteStream {
  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        const next = await read(incoming);
        if (next.done === true) return;
        yield next.value;
      }
    },
    async write(data) {
      if (outgoing.error !== undefined) throw outgoing.error;
      if (outgoing.closed) throw new Error("The byte stream is closed.");
      const copy = Uint8Array.from(data);
      const reader = outgoing.readers.shift();
      if (reader === undefined) outgoing.values.push(copy);
      else reader.resolve({ done: false, value: copy });
    },
    async close() {
      close(outgoing);
    },
    abort(reason) {
      fail(incoming, reason);
      fail(outgoing, reason);
    },
  };
}

async function read(pipe: Pipe): Promise<IteratorResult<Uint8Array>> {
  if (pipe.error !== undefined) throw pipe.error;
  const value = pipe.values.shift();
  if (value !== undefined) return { done: false, value };
  if (pipe.closed) return { done: true, value: undefined };
  return await new Promise((resolve, reject) => pipe.readers.push({ resolve, reject }));
}

function close(pipe: Pipe): void {
  pipe.closed = true;
  for (const reader of pipe.readers.splice(0)) {
    reader.resolve({ done: true, value: undefined });
  }
}

function fail(pipe: Pipe, reason: Error): void {
  if (pipe.error !== undefined) return;
  pipe.error = reason;
  for (const reader of pipe.readers.splice(0)) reader.reject(reason);
}

function testContext(id: string) {
  let services: Services = {};
  const signals = createSignals();
  const storage = createStorage();
  const network = {
    id,
    provide: vi.fn(async (provided: Services) => {
      services = { ...services, ...provided };
    }),
  } as unknown as Network;
  const session = {
    username: id,
    network: vi.fn(async () => network),
    signals: () => signals,
    storage: () => storage,
    bootstrapError: () => undefined,
    close: vi.fn(),
  } as unknown as Session;
  return { id, network, session, services: () => services };
}

function connect(
  local: ReturnType<typeof testContext>,
  remote: ReturnType<typeof testContext>,
): Peer {
  const remoteView = peer(remote.id);
  remoteView.open.mockImplementation(async (protocol: string) => {
    expect(protocol).toBe(dataTransferProtocol);
    const definition = remote.services()[dataTransferServiceName]?.protocols
      ?.find(({ id }) => id === protocol);
    if (definition === undefined) throw new Error("Remote protocol is unavailable.");
    const [outbound, inbound] = streamPair();
    void definition.accept(peer(local.id), inbound);
    return outbound;
  });
  return remoteView;
}

function peer(id: string): Peer & { open: ReturnType<typeof vi.fn> } {
  return {
    id,
    addresses: vi.fn(() => []),
    isConnected: vi.fn(() => true),
    connect: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    service: vi.fn(),
    open: vi.fn(),
  } as unknown as Peer & { open: ReturnType<typeof vi.fn> };
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
  it("streams accepted data with exact metadata, progress, and completion", async () => {
    const localContext = testContext("local");
    const remoteContext = testContext("remote");
    const [local, remote] = await Promise.all([
      createDataTransfer(localContext.session),
      createDataTransfer(remoteContext.session),
    ]);
    const received: number[] = [];
    const localEvents: DataTransferEvent[] = [];
    const remoteEvents: DataTransferEvent[] = [];
    local.events.subscribe((event) => localEvents.push(event));
    remote.events.subscribe((event) => {
      remoteEvents.push(event);
      if (event.type === "offered") event.accept(Promise.resolve(sink(received)));
    });

    local.send(connect(localContext, remoteContext), {
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
    const [local, remote] = await Promise.all([
      createDataTransfer(localContext.session),
      createDataTransfer(remoteContext.session),
    ]);
    const localEvents: DataTransferEvent[] = [];
    const remoteEvents: DataTransferEvent[] = [];
    local.events.subscribe((event) => localEvents.push(event));
    remote.events.subscribe((event) => remoteEvents.push(event));

    local.send(connect(localContext, remoteContext), {
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
    const [local, remote] = await Promise.all([
      createDataTransfer(localContext.session),
      createDataTransfer(remoteContext.session),
    ]);
    const failure = new Error("Offer consumer failed.");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const localEvents: DataTransferEvent[] = [];

    try {
      local.events.subscribe((event) => localEvents.push(event));
      remote.events.subscribe((event) => {
        if (event.type === "offered") throw failure;
      });
      remote.events.subscribe((event) => {
        if (event.type === "offered") event.accept(sink([]));
      });

      local.send(connect(localContext, remoteContext), {
        id: "isolated-consumer",
        size: 0,
        metadata: {},
        data: bytes(),
      });

      await vi.waitFor(() => expect(localEvents.at(-1)?.type).toBe("completed"));
      expect(logged.mock.calls).toEqual([["Signals subscriber failed."]]);
    } finally {
      logged.mockRestore();
    }
  });

  it("aborts partial data and reports failure to both ends", async () => {
    const localContext = testContext("local");
    const remoteContext = testContext("remote");
    const [local, remote] = await Promise.all([
      createDataTransfer(localContext.session),
      createDataTransfer(remoteContext.session),
    ]);
    const target = sink([]);
    const localEvents: DataTransferEvent[] = [];
    const remoteEvents: DataTransferEvent[] = [];
    local.events.subscribe((event) => localEvents.push(event));
    remote.events.subscribe((event) => {
      remoteEvents.push(event);
      if (event.type === "offered") event.accept(target);
    });

    local.send(connect(localContext, remoteContext), {
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

  it("validates outgoing descriptions and limits concurrent transfers", async () => {
    const context = testContext("local");
    const transfer = await createDataTransfer(context.session);
    const never = new Promise<ByteStream>(() => {});
    const remote = peer("remote");
    remote.open.mockImplementation(async () => await never);

    expect(() => transfer.send(remote, {
      id: "invalid",
      size: -1,
      metadata: {},
      data: bytes(),
    })).toThrow("invalid data transfer header");
    expect(() => transfer.send(remote, {
      id: "invalid-metadata",
      size: 0,
      metadata: { missing: undefined } as never,
      data: bytes(),
    })).toThrow("JSON-compatible");

    transfer.send(remote, { id: "one", size: 0, metadata: {}, data: bytes() });
    transfer.send(remote, { id: "two", size: 0, metadata: {}, data: bytes() });
    expect(() => transfer.send(remote, {
      id: "three",
      size: 0,
      metadata: {},
      data: bytes(),
    })).toThrow("already has two outgoing");
  });
});
