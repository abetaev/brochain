import { createChannel, type Channel } from "@c/backend/channel";
import { createStream } from "@c/backend/network";
import type {
  Stream,
  DataSource,
  Peer,
  RPC,
} from "@c/backend/network";

export const dataTransferServiceName = "data-transfer";

export type DataTransferService = {
  readonly remote: RPC<Remote>;
  readonly events: Channel<DataTransferEvent>;
  readonly data: Stream;
  // Present only while this peer hosts the service, because offering a transfer
  // needs the local instance which tracks it.
  send?(transfer: OutgoingTransfer): void;
};

type JsonValue = null | boolean | number | string | JsonValue[] | {
  readonly [key: string]: JsonValue;
};

export type TransferMetadata = Readonly<Record<string, JsonValue>>;

export interface DataSink {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason: Error): Promise<void>;
}

export interface OutgoingTransfer {
  readonly id: string;
  readonly size: number;
  readonly metadata: TransferMetadata;
  readonly data: DataSource;
}

interface TransferEventBase {
  readonly id: string;
  readonly peerId: string;
  readonly direction: "sent" | "received";
  readonly size: number;
  readonly metadata: TransferMetadata;
}

export type DataTransferEvent = Readonly<
  | (TransferEventBase & {
    type: "offered";
    direction: "received";
    accept(sink: DataSink | Promise<DataSink>): void;
    reject(reason?: string): void;
  })
  | (TransferEventBase & { type: "progress"; transferred: number })
  | (TransferEventBase & { type: "completed" })
  | (TransferEventBase & { type: "failed"; error: string })
>;

interface Header {
  readonly id: string;
  readonly size: number;
  readonly metadata: TransferMetadata;
}

type Acceptance = Readonly<
  | { accepted: true }
  | { accepted: false; error: string }
>;

type Completion = Readonly<
  | { complete: true }
  | { complete: false; error: string }
>;

interface Remote {
  offer(header: Header): Promise<Acceptance>;
  complete(id: string): Promise<Completion>;
  cancel(id: string, error: string): void;
}

interface IncomingTransfer {
  readonly header: Header;
  readonly sink: DataSink;
  readonly completion: Promise<Completion>;
  finish(result: Completion): boolean;
  release(): void;
}

const maximumFrameSize = 16 * 1024;
const progressInterval = 250;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createDataTransfer(peer: Peer) {
  const data = createStream();
  const incoming = new Map<string, IncomingTransfer>();
  let inbound = 0;
  let outbound = 0;
  let receiving = true;
  const events = createChannel<DataTransferEvent>();

  const service = {
    data,
    events,
    remote: {
      async offer(value: Header) {
        const header = validateHeader(value);
        if (!receiving) {
          return { accepted: false, error: "Data transfer is unavailable." };
        }
        if (inbound >= 2) {
          return {
            accepted: false,
            error: "This peer already has two incoming data transfers.",
          };
        }
        if (incoming.has(header.id)) {
          return {
            accepted: false,
            error: "A peer reused an active data transfer identifier.",
          };
        }

        let accepted: Promise<DataSink> | undefined;
        let rejected: string | undefined;
        let claimed = false;
        const base = transferBase(peer.id, "received", header);
        events.publish({
          ...base,
          type: "offered",
          accept(candidate) {
            if (claimed) throw new Error("This incoming data transfer is already claimed.");
            claimed = true;
            accepted = Promise.resolve(candidate);
          },
          reject(reason = "The incoming data transfer was rejected.") {
            if (claimed) throw new Error("This incoming data transfer is already claimed.");
            claimed = true;
            rejected = reason;
          },
        });

        if (accepted === undefined) {
          const error = rejected ?? "No consumer accepted the incoming data transfer.";
          events.publish({ ...base, type: "failed", error });
          return { accepted: false, error };
        }

        let sink: DataSink;
        try {
          sink = validateSink(await accepted);
        } catch (reason) {
          const error = errorMessage(
            reason,
            "The incoming data transfer could not be stored.",
          );
          events.publish({ ...base, type: "failed", error });
          return { accepted: false, error };
        }

        inbound += 1;
        let finished = false;
        let complete!: (result: Completion) => void;
        const completion = new Promise<Completion>((resolve) => {
          complete = resolve;
        });
        incoming.set(header.id, {
          header,
          sink,
          completion,
          finish(result) {
            if (finished) return false;
            finished = true;
            complete(result);
            return true;
          },
          release() {
            inbound -= 1;
          },
        });
        return { accepted: true };
      },
      async complete(id: string) {
        const transfer = incomingTransfer(incoming, id);
        const completion = await transfer.completion;
        incoming.delete(id);
        transfer.release();
        return completion;
      },
      cancel(id: string, error: string) {
        const transfer = incoming.get(id);
        if (transfer === undefined) return;
        const failure = new Error(validError(error));
        if (finish(transfer, { complete: false, error: failure.message })) {
          void transfer.sink.abort(failure).catch(() => {});
        }
        incoming.delete(id);
        transfer.release();
      },
    },
    send(value: OutgoingTransfer) {
      const transfer = validateOutgoing(value);
      if (outbound >= 2) {
        throw new Error("This peer already has two outgoing data transfers.");
      }
      outbound += 1;
      void sendTransfer(transfer).finally(() => {
        outbound -= 1;
      }).catch(() => {});
    },
  };
  void receiveTransfers().catch((reason) => {
    receiving = false;
    const failure = asError(reason, "Incoming data transfers stopped.");
    for (const transfer of incoming.values()) {
      if (finish(transfer, { complete: false, error: failure.message })) {
        void transfer.sink.abort(failure).catch(() => {});
      }
    }
  });
  return service;

  async function sendTransfer(transfer: OutgoingTransfer): Promise<void> {
    const base = transferBase(peer.id, "sent", transfer);
    const transfers = peer.service<DataTransferService>(dataTransferServiceName);
    try {
      const acceptance = validateAcceptance(await transfers.remote.offer({
        id: transfer.id,
        size: transfer.size,
        metadata: transfer.metadata,
      }));
      if (!acceptance.accepted) throw new Error(acceptance.error);

      const progress = createProgress(events, base);
      progress(0);
      await transfers.data.send(outgoingData(transfer, progress));
      const completion = validateCompletion(await transfers.remote.complete(transfer.id));
      if (!completion.complete) throw new Error(completion.error);
      events.publish({ ...base, type: "completed" });
    } catch (reason) {
      const failure = asError(reason, "The outgoing data transfer failed.");
      void transfers.remote.cancel(transfer.id, failure.message).catch(() => {});
      events.publish({ ...base, type: "failed", error: failure.message });
    }
  }

  async function receiveTransfers(): Promise<void> {
    while (true) {
      const source = await data.accept();
      void receive(source).catch(() => {});
    }
  }

  async function receive(source: DataSource): Promise<void> {
    const reader = createFrameReader(source);
    let transfer: IncomingTransfer | undefined;
    try {
      const header = validateHeader(await reader.read());
      transfer = incomingTransfer(incoming, header.id);
      if (!sameHeader(header, transfer.header)) {
        throw new Error("Peer sent data which does not match its accepted offer.");
      }

      const progress = createProgress(
        events,
        transferBase(peer.id, "received", transfer.header),
      );
      progress(0);
      let transferred = 0;
      for await (const data of reader.remaining()) {
        if (transferred + data.byteLength > transfer.header.size) {
          throw new Error("The peer sent more data than it declared.");
        }
        await transfer.sink.write(data);
        transferred += data.byteLength;
        progress(transferred);
      }
      if (transferred !== transfer.header.size) {
        throw new Error("The peer sent less data than it declared.");
      }

      await transfer.sink.close();
      finish(transfer, { complete: true });
    } catch (reason) {
      const failure = asError(reason, "The incoming data transfer failed.");
      if (
        transfer !== undefined &&
        finish(transfer, { complete: false, error: failure.message })
      ) {
        await transfer.sink.abort(failure).catch(() => {});
      }
      throw failure;
    }
  }

  function finish(transfer: IncomingTransfer, result: Completion): boolean {
    if (!transfer.finish(result)) return false;
    const base = transferBase(peer.id, "received", transfer.header);
    events.publish(result.complete
      ? { ...base, type: "completed" }
      : { ...base, type: "failed", error: result.error });
    return true;
  }
}

async function* outgoingData(
  transfer: OutgoingTransfer,
  progress: (transferred: number) => void,
): AsyncGenerator<Uint8Array> {
  yield framed({
    id: transfer.id,
    size: transfer.size,
    metadata: transfer.metadata,
  });
  let transferred = 0;
  for await (const data of transfer.data) {
    if (!(data instanceof Uint8Array)) {
      throw new Error("A data transfer source produced a non-byte value.");
    }
    if (transferred + data.byteLength > transfer.size) {
      throw new Error("The data transfer source exceeded its declared size.");
    }
    transferred += data.byteLength;
    progress(transferred);
    yield data;
  }
  if (transferred !== transfer.size) {
    throw new Error("The data transfer source did not reach its declared size.");
  }
}

function incomingTransfer(
  incoming: Map<string, IncomingTransfer>,
  id: unknown,
): IncomingTransfer {
  if (typeof id !== "string") throw new Error("Peer sent an invalid data transfer ID.");
  const transfer = incoming.get(id);
  if (transfer === undefined) throw new Error("Peer sent an unaccepted data transfer.");
  return transfer;
}

function transferBase<Direction extends "sent" | "received">(
  peerId: string,
  direction: Direction,
  transfer: Header,
): TransferEventBase & { readonly direction: Direction } {
  return {
    id: transfer.id,
    peerId,
    direction,
    size: transfer.size,
    metadata: transfer.metadata,
  };
}

function createProgress(
  events: Channel<DataTransferEvent>,
  base: TransferEventBase,
): (transferred: number) => void {
  let last = Number.NEGATIVE_INFINITY;
  return (transferred) => {
    const now = Date.now();
    if (transferred !== 0 && transferred !== base.size && now - last < progressInterval) return;
    last = now;
    events.publish({ ...base, type: "progress", transferred });
  };
}

function validateOutgoing(value: OutgoingTransfer): OutgoingTransfer {
  const header = validateHeader(value);
  if (
    typeof value !== "object" ||
    value === null ||
    !("data" in value) ||
    typeof value.data !== "object" ||
    value.data === null ||
    !(Symbol.asyncIterator in value.data)
  ) {
    throw new Error("A data transfer requires an asynchronous byte source.");
  }
  return { ...header, data: value.data };
}

function validateHeader(value: unknown): Header {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 128 ||
    !("size" in value) ||
    !Number.isSafeInteger(value.size) ||
    (value.size as number) < 0 ||
    !("metadata" in value)
  ) {
    throw new Error("Peer sent an invalid data transfer header.");
  }

  const metadata = cloneMetadata(value.metadata);
  const header = { id: value.id, size: value.size as number, metadata };
  if (encodedFrame(header).byteLength > maximumFrameSize) {
    throw new Error("The data transfer metadata is too large.");
  }
  return header;
}

function cloneMetadata(value: unknown): TransferMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Data transfer metadata must be an object.");
  }
  if (!isJsonObject(value)) {
    throw new Error("Data transfer metadata must contain JSON-compatible values.");
  }
  try {
    const encoded = JSON.stringify(value);
    const clone: unknown = JSON.parse(encoded);
    if (typeof clone !== "object" || clone === null || Array.isArray(clone)) throw new Error();
    return clone as TransferMetadata;
  } catch {
    throw new Error("Data transfer metadata must contain JSON-compatible values.");
  }
}

function isJsonObject(value: object, seen = new WeakSet<object>()): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Object.values(value).every((entry) => isJsonValue(entry, seen));
  seen.delete(value);
  return valid;
}

function isJsonValue(value: unknown, seen: WeakSet<object>): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    const valid = value.every((entry) => isJsonValue(entry, seen));
    seen.delete(value);
    return valid;
  }
  return typeof value === "object" && value !== null && isJsonObject(value, seen);
}

function validateAcceptance(value: unknown): Acceptance {
  if (typeof value !== "object" || value === null || !("accepted" in value)) {
    throw new Error("Peer returned an invalid data transfer response.");
  }
  if (value.accepted === true) return { accepted: true };
  if (
    value.accepted === false &&
    "error" in value &&
    typeof value.error === "string" &&
    value.error.length > 0
  ) {
    return { accepted: false, error: value.error };
  }
  throw new Error("Peer returned an invalid data transfer response.");
}

function validateCompletion(value: unknown): Completion {
  if (typeof value !== "object" || value === null || !("complete" in value)) {
    throw new Error("Peer returned an invalid data transfer completion.");
  }
  if (value.complete === true) return { complete: true };
  if (
    value.complete === false &&
    "error" in value &&
    typeof value.error === "string" &&
    value.error.length > 0
  ) {
    return { complete: false, error: value.error };
  }
  throw new Error("Peer returned an invalid data transfer completion.");
}

function validateSink(value: unknown): DataSink {
  if (
    typeof value !== "object" ||
    value === null ||
    !("write" in value) ||
    typeof value.write !== "function" ||
    !("close" in value) ||
    typeof value.close !== "function" ||
    !("abort" in value) ||
    typeof value.abort !== "function"
  ) {
    throw new Error("An incoming data transfer requires a writable data sink.");
  }
  return value as DataSink;
}

function createFrameReader(source: DataSource): {
  read(): Promise<unknown>;
  remaining(): DataSource;
} {
  const iterator = source[Symbol.asyncIterator]();
  let buffered = new Uint8Array();

  return {
    async read() {
      while (true) {
        const newline = buffered.indexOf(10);
        if (newline >= 0) {
          if (newline > maximumFrameSize) {
            throw new Error("Peer sent an oversized data transfer frame.");
          }
          const frame = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          return JSON.parse(decoder.decode(frame));
        }
        if (buffered.byteLength > maximumFrameSize) {
          throw new Error("Peer sent an oversized data transfer frame.");
        }
        const next = await iterator.next();
        if (next.done === true) throw new Error("Peer closed an incomplete data transfer frame.");
        if (!(next.value instanceof Uint8Array)) {
          throw new Error("A data transfer source produced a non-byte value.");
        }
        buffered = concatenate(buffered, next.value);
      }
    },
    async *remaining() {
      if (buffered.byteLength > 0) {
        yield buffered;
        buffered = new Uint8Array();
      }
      while (true) {
        const next = await iterator.next();
        if (next.done === true) return;
        if (!(next.value instanceof Uint8Array)) {
          throw new Error("A data transfer source produced a non-byte value.");
        }
        yield next.value;
      }
    },
  };
}

function framed(value: unknown): Uint8Array {
  const encoded = encodedFrame(value);
  if (encoded.byteLength > maximumFrameSize) {
    throw new Error("The data transfer frame is too large.");
  }
  const frame = new Uint8Array(encoded.byteLength + 1);
  frame.set(encoded);
  frame[encoded.byteLength] = 10;
  return frame;
}

function encodedFrame(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function concatenate(
  first: Uint8Array<ArrayBufferLike>,
  second: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  const combined = new Uint8Array(first.byteLength + second.byteLength);
  combined.set(first);
  combined.set(second, first.byteLength);
  return combined;
}

function sameHeader(first: Header, second: Header): boolean {
  return first.id === second.id &&
    first.size === second.size &&
    JSON.stringify(first.metadata) === JSON.stringify(second.metadata);
}

function validError(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Peer sent an invalid data transfer failure.");
  }
  return value;
}

function asError(reason: unknown, fallback: string): Error {
  return reason instanceof Error && reason.message.length > 0
    ? reason
    : new Error(errorMessage(reason, fallback));
}

function errorMessage(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message.length > 0) return reason.message;
  if (typeof reason === "string" && reason.length > 0) return reason;
  return fallback;
}
