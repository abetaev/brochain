import { createStream } from "@c/backend/network";
import type { DataSource, Peer, RPC, Stream, Transfer } from "@c/backend/network";
import signals from "@c/backend/signals";
import type { Subscription } from "@c/backend/signals";

export const dataTransferServiceName = "data-transfer";

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
  readonly size?: number;
  readonly metadata: TransferMetadata;
  readonly data: DataSource;
}

interface TransferEventBase {
  readonly id: string;
  readonly peerId: string;
  readonly direction: "sent" | "received";
  readonly size?: number;
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
  readonly size?: number;
  readonly metadata: TransferMetadata;
}

type Acceptance = Readonly<
  | { accepted: true }
  | { accepted: false; error: string }
>;

type Remote = {
  offer(header: Header): Promise<Acceptance>;
};

export type DataTransferService = {
  readonly remote: RPC<Remote>;
  readonly events: Subscription<DataTransferEvent>;
  readonly data: Stream;
  // Present only while this peer hosts the service, because offering a transfer
  // needs the local instance which tracks it.
  send?(transfer: OutgoingTransfer): void;
};

export function createDataTransfer(peer: Peer) {
  const data = createStream();
  const events = signals.channel<DataTransferEvent>();
  const offered = new Map<string, { readonly header: Header; readonly sink: Promise<DataSink> }>();

  const service = {
    data,
    events,
    remote: {
      async offer(value: Header): Promise<Acceptance> {
        const header = validateHeader(value);
        if (offered.has(header.id)) {
          return { accepted: false, error: "A peer reused an active data transfer identifier." };
        }

        let sink: DataSink | Promise<DataSink> | undefined;
        let refusal: string | undefined;
        events.publish({
          ...eventBase(peer.id, "received", header),
          direction: "received",
          type: "offered",
          accept(claimed) {
            sink = claimed;
          },
          reject(reason) {
            refusal = reason ?? "The data transfer was rejected.";
          },
        });
        if (sink === undefined) {
          return { accepted: false, error: refusal ?? "No receiver accepted the data transfer." };
        }

        offered.set(header.id, { header, sink: Promise.resolve(sink) });
        return { accepted: true };
      },
    },
    send(outgoing: OutgoingTransfer) {
      void sendTransfer(outgoing);
    },
  };

  void receiveTransfers();
  return service;

  async function sendTransfer(outgoing: OutgoingTransfer): Promise<void> {
    const remote = peer.service<DataTransferService>(dataTransferServiceName);
    const base = eventBase(peer.id, "sent", outgoing);
    try {
      const acceptance = validateAcceptance(await remote.remote.offer({
        id: outgoing.id,
        size: outgoing.size,
        metadata: outgoing.metadata,
      }));
      if (!acceptance.accepted) throw new Error(acceptance.error);

      const transfer = remote.data.send(outgoing.data, {
        id: outgoing.id,
        size: outgoing.size,
      });
      await report(base, transfer, async () => await transfer.completion);
      events.publish({ ...base, type: "completed" });
    } catch (reason) {
      events.publish({ ...base, type: "failed", error: errorMessage(reason) });
    }
  }

  async function receiveTransfers(): Promise<void> {
    try {
      while (true) void receive(await data.accept());
    } catch {
      // The service was removed or the peer disconnected; pending offers expire with it.
    }
  }

  async function receive(transfer: Transfer): Promise<void> {
    const offer = offered.get(transfer.id);
    offered.delete(transfer.id);
    if (offer === undefined) {
      transfer.cancel(new Error("A peer sent data which was never offered."));
      return;
    }

    const base = eventBase(peer.id, "received", offer.header);
    let sink: DataSink | undefined;
    try {
      if (transfer.size !== offer.header.size) {
        throw new Error("Peer sent data which does not match its accepted offer.");
      }
      sink = await offer.sink;
      const receiving = sink;
      await report(base, transfer, async () => {
        for await (const chunk of transfer.data()) await receiving.write(chunk);
        await receiving.close();
      });
      events.publish({ ...base, type: "completed" });
    } catch (reason) {
      const failure = asError(reason);
      transfer.cancel(failure);
      await sink?.abort(failure).catch(() => {});
      events.publish({ ...base, type: "failed", error: failure.message });
    }
  }

  async function report(
    base: TransferEventBase,
    transfer: Transfer,
    work: () => Promise<void>,
  ): Promise<void> {
    const stop = transfer.progress.subscribe((transferred) => {
      events.publish({ ...base, type: "progress", transferred });
    });
    try {
      await work();
    } finally {
      stop();
    }
  }
}

function eventBase(
  peerId: string,
  direction: "sent" | "received",
  header: Header,
): TransferEventBase {
  return {
    id: header.id,
    peerId,
    direction,
    ...(header.size === undefined ? {} : { size: header.size }),
    metadata: header.metadata,
  };
}

function validateHeader(value: unknown): Header {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 128 ||
    !("metadata" in value)
  ) {
    throw new Error("Peer sent an invalid data transfer offer.");
  }
  const size = "size" in value ? value.size : undefined;
  if (
    size !== undefined &&
    (typeof size !== "number" || !Number.isInteger(size) || size < 0)
  ) {
    throw new Error("Peer sent an invalid data transfer offer.");
  }
  return {
    id: value.id,
    ...(size === undefined ? {} : { size }),
    metadata: validateMetadata(value.metadata),
  };
}

function validateMetadata(value: unknown): TransferMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Data transfer metadata must be an object.");
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, validateJson(entry)]),
    ),
  );
}

function validateJson(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(validateJson);
  if (typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, validateJson(entry)]),
      ),
    );
  }
  throw new Error("Data transfer metadata must contain JSON-compatible values.");
}

function validateAcceptance(value: unknown): Acceptance {
  if (
    typeof value !== "object" ||
    value === null ||
    !("accepted" in value) ||
    typeof value.accepted !== "boolean"
  ) {
    throw new Error("Peer returned an invalid data transfer response.");
  }
  if (value.accepted) return { accepted: true };
  if (!("error" in value) || typeof value.error !== "string" || value.error.length === 0) {
    throw new Error("Peer returned an invalid data transfer rejection.");
  }
  return { accepted: false, error: value.error };
}

function errorMessage(reason: unknown): string {
  return asError(reason).message;
}

function asError(reason: unknown): Error {
  if (reason instanceof Error && reason.message.length > 0) return reason;
  if (typeof reason === "string" && reason.length > 0) return new Error(reason);
  return new Error("The data transfer failed.");
}
