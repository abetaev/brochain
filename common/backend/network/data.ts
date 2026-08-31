import signals from "../signals.ts";
import type { Subscription } from "../signals.ts";
import type { ByteStream } from "./byte-stream.ts";

export type DataSource = AsyncIterable<Uint8Array>;

export interface TransferOptions {
  readonly id?: string;
  // Absent when the length is not known in advance, as for a live capture.
  readonly size?: number;
}

export interface Transfer {
  readonly id: string;
  readonly size?: number;
  readonly progress: Subscription<number>;
  readonly completion: Promise<void>;
  transferred(): number;
  data(): DataSource;
  cancel(reason: Error): void;
}

export interface Stream {
  send(data: DataSource, options?: TransferOptions): Transfer;
  accept(): Promise<Transfer>;
  abort(reason: Error): void;
}

export const dataProtocol = "/brochain/data/1.0.0";

const progressInterval = 250;
const concurrentTransfers = 2;

interface TrackedTransfer {
  readonly transfer: Transfer;
  readonly consumed: Promise<void>;
  finish(reason?: unknown): void;
}

function trackTransfer(source: DataSource, options?: TransferOptions): TrackedTransfer {
  const progress = signals.channel<number>();
  let transferred = 0;
  let published = 0;
  let cancellation: Error | undefined;
  let settled = false;

  let complete!: () => void;
  let fail!: (reason: unknown) => void;
  const completion = new Promise<void>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });

  let consumedFully!: () => void;
  let consumptionFailed!: (reason: unknown) => void;
  const consumed = new Promise<void>((resolve, reject) => {
    consumedFully = resolve;
    consumptionFailed = reject;
  });

  // Both outcomes are reported through the transfer, so neither is awaited here.
  void completion.catch(() => {});
  void consumed.catch(() => {});

  function finish(reason?: unknown): void {
    if (settled) return;
    settled = true;
    progress.publish(transferred);
    if (reason === undefined) complete();
    else fail(reason);
  }

  async function* counted(): AsyncGenerator<Uint8Array> {
    let ended = false;
    try {
      for await (const chunk of source) {
        if (cancellation !== undefined) throw cancellation;
        if (!(chunk instanceof Uint8Array)) {
          throw new Error("A data source may contain only byte arrays.");
        }
        transferred += chunk.byteLength;
        const now = Date.now();
        if (now - published >= progressInterval) {
          published = now;
          progress.publish(transferred);
        }
        yield chunk;
      }
      ended = true;
      consumedFully();
    } catch (reason) {
      consumptionFailed(reason);
      throw reason;
    } finally {
      if (!ended) consumptionFailed(new Error("The data transfer was not fully consumed."));
    }
  }

  return {
    consumed,
    finish,
    transfer: Object.freeze({
      id: options?.id ?? crypto.randomUUID(),
      ...(options?.size === undefined ? {} : { size: options.size }),
      progress,
      completion,
      transferred: () => transferred,
      data: counted,
      cancel(reason: Error) {
        cancellation = reason;
        finish(reason);
      },
    }),
  };
}

export function createStream(
  transmit?: (transfer: Transfer, data: DataSource) => Promise<void>,
): Stream {
  const queued: TrackedTransfer[] = [];
  const receivers: Array<{
    readonly resolve: (transfer: Transfer) => void;
    readonly reject: (reason: unknown) => void;
  }> = [];
  const active = new Set<Transfer>();
  let closed: Error | undefined;

  function match(): void {
    while (queued.length > 0 && receivers.length > 0) {
      const tracked = queued.shift();
      const receiver = receivers.shift();
      if (tracked === undefined || receiver === undefined) return;
      receiver.resolve(tracked.transfer);
    }
  }

  return Object.freeze({
    send(data: DataSource, options?: TransferOptions) {
      requireDataSource(data);
      const tracked = trackTransfer(data, options);
      const { transfer, finish } = tracked;

      if (closed !== undefined) finish(closed);
      else if (active.size >= concurrentTransfers) {
        finish(new Error("This peer already has two active data transfers."));
      } else {
        active.add(transfer);
        void transfer.completion.catch(() => {}).then(() => active.delete(transfer));
        if (transmit === undefined) {
          void tracked.consumed.then(() => finish(), finish);
          queued.push(tracked);
          match();
        } else {
          void transmit(transfer, transfer.data()).then(() => finish(), finish);
        }
      }
      return transfer;
    },
    async accept() {
      if (closed !== undefined) throw closed;
      return await new Promise<Transfer>((resolve, reject) => {
        receivers.push({ resolve, reject });
        match();
      });
    },
    abort(reason: Error) {
      closed = reason;
      for (const tracked of queued.splice(0)) tracked.finish(reason);
      for (const receiver of receivers.splice(0)) receiver.reject(reason);
    },
  });
}

export function createRemoteStream(
  serviceName: string,
  open: () => Promise<ByteStream>,
): Stream {
  return createStream(async (transfer, data) => {
    const stream = await open();
    try {
      await stream.writeLine({
        service: serviceName,
        id: transfer.id,
        ...(transfer.size === undefined ? {} : { size: transfer.size }),
      });
      for await (const chunk of data) await stream.write(chunk);
      await stream.close();
      const response = validateResponse(JSON.parse(await stream.readLine()));
      if (!response.accepted) throw new Error(response.error);
    } catch (reason) {
      stream.abort(asError(reason));
      throw reason;
    }
  });
}

export async function answerData(
  stream: ByteStream,
  service: (name: string) => Stream | undefined,
): Promise<void> {
  try {
    const header = validateHeader(JSON.parse(await stream.readLine()));
    const data = service(header.service);
    if (data === undefined) throw new Error("This data service is not available to the peer.");
    await data.send(stream, { id: header.id, size: header.size }).completion;
    await stream.writeLine({ accepted: true });
    await stream.close();
  } catch (reason) {
    try {
      await stream.writeLine({ accepted: false, error: errorMessage(reason) });
      await stream.close();
    } catch {
      stream.abort(asError(reason));
    }
  }
}

function requireDataSource(value: unknown): asserts value is DataSource {
  if (
    typeof value !== "object" ||
    value === null ||
    !(Symbol.asyncIterator in value) ||
    typeof value[Symbol.asyncIterator] !== "function"
  ) {
    throw new Error("Data must be an asynchronous source of byte arrays.");
  }
}

function validateHeader(
  value: unknown,
): { readonly service: string; readonly id: string; readonly size?: number } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("service" in value) ||
    typeof value.service !== "string" ||
    value.service.length === 0 ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    value.id.length === 0
  ) {
    throw new Error("The peer sent an invalid data request.");
  }
  if (!("size" in value) || value.size === undefined) {
    return { service: value.service, id: value.id };
  }
  if (typeof value.size !== "number" || !Number.isInteger(value.size) || value.size < 0) {
    throw new Error("The peer sent an invalid data request.");
  }
  return { service: value.service, id: value.id, size: value.size };
}

function validateResponse(
  value: unknown,
): { readonly accepted: boolean; readonly error?: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("accepted" in value) ||
    typeof value.accepted !== "boolean"
  ) {
    throw new Error("The peer returned an invalid data response.");
  }
  if (value.accepted) return { accepted: true };
  if (!("error" in value) || typeof value.error !== "string" || value.error.length === 0) {
    throw new Error("The peer returned an invalid data rejection.");
  }
  return { accepted: false, error: value.error };
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error && reason.message.length > 0
    ? reason.message
    : "The data transfer failed.";
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}
