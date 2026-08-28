import type { ByteStream, Peer } from "@c/backend/network";
import type { Session } from "@v/backend/session";
import type { Channel } from "@v/backend/signals";
import { isServiceEnabled } from "@v/backend/options/network-services";

export const dataTransferServiceName = "data-transfer";
export const dataTransferProtocol = "/brochain/data-transfer/1.0.0";

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
  readonly data: AsyncIterable<Uint8Array>;
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

export interface DataTransfer {
  readonly events: Channel<DataTransferEvent>;
  send(peer: Peer, transfer: OutgoingTransfer): void;
}

interface Header {
  readonly id: string;
  readonly size: number;
  readonly metadata: TransferMetadata;
}

const maximumFrameSize = 16 * 1024;
const progressInterval = 250;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function createDataTransfer(session: Session): Promise<DataTransfer> {
  const events = session.signals().channel<DataTransferEvent>({}, "events");
  const inbound = new Map<string, number>();
  const outbound = new Map<string, number>();
  const options = session.options();
  const network = await session.network();

  await network.provide({
    [dataTransferServiceName]: {
      enabled: (peer) => isServiceEnabled(
        options,
        peer.id,
        dataTransferServiceName,
      ),
      protocols: [{
        id: dataTransferProtocol,
        maxInboundStreams: 2,
        maxOutboundStreams: 2,
        accept: receive,
      }],
    },
  });

  async function receive(peer: Peer, stream: ByteStream): Promise<void> {
    const release = occupy(inbound, peer.id);
    if (release === undefined) {
      stream.abort(new Error("This peer has too many incoming data transfers."));
      return;
    }

    const reader = createFrameReader(stream);
    let header: Header | undefined;
    let sink: DataSink | undefined;
    try {
      header = validateHeader(await reader.read());
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
        const reason = rejected ?? "No consumer accepted the incoming data transfer.";
        await writeFrame(stream, { accepted: false, error: reason });
        await stream.close();
        events.publish({ ...base, type: "failed", error: reason });
        return;
      }

      try {
        sink = validateSink(await accepted);
      } catch (reason) {
        const message = errorMessage(reason, "The incoming data transfer could not be stored.");
        await writeFrame(stream, { accepted: false, error: message });
        await stream.close();
        events.publish({ ...base, type: "failed", error: message });
        return;
      }

      await writeFrame(stream, { accepted: true });
      const progress = createProgress(events, base);
      progress(0);
      let transferred = 0;
      for await (const data of reader.remaining()) {
        if (transferred + data.byteLength > header.size) {
          throw new Error("The peer sent more data than it declared.");
        }
        await sink.write(data);
        transferred += data.byteLength;
        progress(transferred);
      }
      if (transferred !== header.size) {
        throw new Error("The peer sent less data than it declared.");
      }

      await sink.close();
      await writeFrame(stream, { complete: true });
      await stream.close();
      events.publish({ ...base, type: "completed" });
    } catch (reason) {
      const failure = asError(reason, "The incoming data transfer failed.");
      await sink?.abort(failure).catch(() => {});
      if (header !== undefined) {
        events.publish({
          ...transferBase(peer.id, "received", header),
          type: "failed",
          error: failure.message,
        });
      }
      abort(stream, failure);
    } finally {
      release();
    }
  }

  return {
    events,
    send(peer, value) {
      const transfer = validateOutgoing(value);
      const release = occupy(outbound, peer.id);
      if (release === undefined) {
        throw new Error("This peer already has two outgoing data transfers.");
      }
      void send(peer, transfer).finally(release).catch(() => {});
    },
  };

  async function send(peer: Peer, transfer: OutgoingTransfer): Promise<void> {
    const base = transferBase(peer.id, "sent", transfer);
    let stream: ByteStream | undefined;
    try {
      stream = await peer.open(dataTransferProtocol);
      const reader = createFrameReader(stream);
      await writeFrame(stream, {
        id: transfer.id,
        size: transfer.size,
        metadata: transfer.metadata,
      });
      const acceptance = validateAcceptance(await reader.read());
      if (!acceptance.accepted) throw new Error(acceptance.error);

      const progress = createProgress(events, base);
      progress(0);
      let transferred = 0;
      for await (const data of transfer.data) {
        if (!(data instanceof Uint8Array)) {
          throw new Error("A data transfer source produced a non-byte value.");
        }
        if (transferred + data.byteLength > transfer.size) {
          throw new Error("The data transfer source exceeded its declared size.");
        }
        await stream.write(data);
        transferred += data.byteLength;
        progress(transferred);
      }
      if (transferred !== transfer.size) {
        throw new Error("The data transfer source did not reach its declared size.");
      }

      await stream.close();
      validateCompletion(await reader.read());
      events.publish({ ...base, type: "completed" });
    } catch (reason) {
      const failure = asError(reason, "The outgoing data transfer failed.");
      if (stream !== undefined) abort(stream, failure);
      events.publish({ ...base, type: "failed", error: failure.message });
    }
  }
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

function occupy(counts: Map<string, number>, peerId: string): (() => void) | undefined {
  const current = counts.get(peerId) ?? 0;
  if (current >= 2) return undefined;
  counts.set(peerId, current + 1);
  return () => {
    const remaining = (counts.get(peerId) ?? 1) - 1;
    if (remaining === 0) counts.delete(peerId);
    else counts.set(peerId, remaining);
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
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
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
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }
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

function validateAcceptance(value: unknown):
  | { readonly accepted: true }
  | { readonly accepted: false; readonly error: string } {
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

function validateCompletion(value: unknown): void {
  if (
    typeof value !== "object" ||
    value === null ||
    !("complete" in value) ||
    value.complete !== true
  ) {
    throw new Error("Peer did not acknowledge the completed data transfer.");
  }
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

function createFrameReader(stream: ByteStream): {
  read(): Promise<unknown>;
  remaining(): AsyncIterable<Uint8Array>;
} {
  const iterator = stream[Symbol.asyncIterator]();
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
        yield next.value;
      }
    },
  };
}

async function writeFrame(stream: ByteStream, value: unknown): Promise<void> {
  const encoded = encodedFrame(value);
  if (encoded.byteLength > maximumFrameSize) {
    throw new Error("The data transfer frame is too large.");
  }
  const framed = new Uint8Array(encoded.byteLength + 1);
  framed.set(encoded);
  framed[encoded.byteLength] = 10;
  await stream.write(framed);
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

function abort(stream: ByteStream, reason: Error): void {
  try {
    stream.abort(reason);
  } catch {
    // A concurrently closed stream has already released its transport resources.
  }
}
