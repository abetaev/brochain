import type { ByteStream } from "./byte-stream.ts";
import { encodeLine, splitLine } from "./framing.ts";

export type DataSource = AsyncIterable<Uint8Array>;

export interface Stream {
  accept(): Promise<DataSource>;
  send(data: DataSource): Promise<void>;
}

interface Transfer {
  readonly source: DataSource;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

interface DataControl {
  deliver(source: DataSource): Promise<void>;
  cancel(reason: Error): void;
}

interface DataResponse {
  readonly accepted: boolean;
  readonly error?: string;
}

export const dataProtocol = "/brochain/data/1.0.0";

const controls = new WeakMap<Stream, DataControl>();

export function createStream(
  transmit?: (data: DataSource) => Promise<void>,
): Stream {
  const transfers: Transfer[] = [];
  const receivers: Array<{
    readonly resolve: (source: DataSource) => void;
    readonly reject: (reason: unknown) => void;
  }> = [];
  let closed: Error | undefined;

  function deliver(source: DataSource): Promise<void> {
    requireDataSource(source);
    if (closed !== undefined) return Promise.reject(closed);
    return new Promise<void>((resolve, reject) => {
      transfers.push({ source, resolve, reject });
      match();
    });
  }

  function match(): void {
    while (transfers.length > 0 && receivers.length > 0) {
      const transfer = transfers.shift();
      const receiver = receivers.shift();
      if (transfer === undefined || receiver === undefined) return;
      receiver.resolve(consumed(transfer));
    }
  }

  const data: Stream = Object.freeze({
    accept() {
      if (closed !== undefined) return Promise.reject(closed);
      return new Promise<DataSource>((resolve, reject) => {
        receivers.push({ resolve, reject });
        match();
      });
    },
    async send(source: DataSource) {
      requireDataSource(source);
      await (transmit === undefined ? deliver(source) : transmit(source));
    },
  });

  controls.set(data, {
    deliver,
    cancel(reason) {
      closed = reason;
      for (const transfer of transfers.splice(0)) transfer.reject(reason);
      for (const receiver of receivers.splice(0)) receiver.reject(reason);
    },
  });
  return data;
}

export async function deliverData(data: Stream, source: DataSource): Promise<void> {
  const control = controls.get(data);
  if (control === undefined) await data.send(source);
  else await control.deliver(source);
}

export function cancelData(data: Stream, reason: Error): void {
  controls.get(data)?.cancel(reason);
}

export function createRemoteData(
  serviceName: string,
  open: () => Promise<ByteStream>,
): Stream {
  return createStream(async (source) => {
    const stream = await open();
    try {
      await stream.write(encodeLine({ service: serviceName }));
      for await (const chunk of source) {
        if (!(chunk instanceof Uint8Array)) {
          throw new Error("A data source may contain only byte arrays.");
        }
        await stream.write(chunk);
      }
      await stream.close();
      const response = validateResponse(JSON.parse((await splitLine(stream)).line));
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
    const request = await splitLine(stream);
    const name = serviceName(JSON.parse(request.line));
    const data = service(name);
    if (data === undefined) throw new Error("This data service is not available to the peer.");
    await deliverData(data, request.remaining);
    await stream.write(encodeLine({ accepted: true }));
    await stream.close();
  } catch (reason) {
    try {
      await stream.write(encodeLine({ accepted: false, error: errorMessage(reason) }));
      await stream.close();
    } catch {
      stream.abort(asError(reason));
    }
  }
}

async function* consumed(transfer: Transfer): AsyncGenerator<Uint8Array> {
  let complete = false;
  try {
    for await (const chunk of transfer.source) {
      if (!(chunk instanceof Uint8Array)) {
        throw new Error("A data source may contain only byte arrays.");
      }
      yield chunk;
    }
    complete = true;
    transfer.resolve();
  } catch (reason) {
    transfer.reject(reason);
    throw reason;
  } finally {
    if (!complete) {
      transfer.reject(new Error("The incoming data transfer was not fully consumed."));
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

function serviceName(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    !("service" in value) ||
    typeof value.service !== "string" ||
    value.service.length === 0
  ) {
    throw new Error("The peer sent an invalid data request.");
  }
  return value.service;
}

function validateResponse(value: unknown): DataResponse {
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
