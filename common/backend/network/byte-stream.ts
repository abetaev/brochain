import type { Libp2p } from "libp2p";

type Stream = Awaited<ReturnType<Libp2p["dialProtocol"]>>;

// Protocols which precede their content with a JSON header read it as one line and
// then keep reading the same stream, so the stream owns its read position.
export interface ByteStream extends AsyncIterable<Uint8Array> {
  write(data: Uint8Array, options?: { readonly signal?: AbortSignal }): Promise<void>;
  writeLine(value: unknown, options?: { readonly signal?: AbortSignal }): Promise<void>;
  readLine(): Promise<string>;
  readLines(): AsyncGenerator<string>;
  close(options?: { readonly signal?: AbortSignal }): Promise<void>;
  abort(reason: Error): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const lineFeed = 10;

export function createByteStream(stream: Stream): ByteStream {
  const buffered: Uint8Array[] = [];
  let reader: AsyncGenerator<Uint8Array> | undefined;

  async function* incoming(): AsyncGenerator<Uint8Array> {
    for await (const chunk of stream) {
      yield chunk instanceof Uint8Array ? chunk : chunk.subarray();
    }
  }

  async function read(): Promise<Uint8Array | undefined> {
    const pending = buffered.shift();
    if (pending !== undefined) return pending;
    reader ??= incoming();
    const next = await reader.next();
    return next.done === true ? undefined : next.value;
  }

  const bytes: ByteStream = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        const chunk = await read();
        if (chunk === undefined) return;
        yield chunk;
      }
    },
    async write(data, options) {
      requireWritableData(data);
      const signal = options?.signal;
      signal?.throwIfAborted();
      if (stream.writableNeedsDrain) await waitForDrain(stream, signal);
      if (!stream.send(data)) await waitForDrain(stream, signal);
    },
    async writeLine(value, options) {
      await bytes.write(encoder.encode(`${JSON.stringify(value)}\n`), options);
    },
    async readLine() {
      const parts: Uint8Array[] = [];
      while (true) {
        const chunk = await read();
        if (chunk === undefined) throw new Error("The peer ended an incomplete frame.");
        const boundary = chunk.indexOf(lineFeed);
        if (boundary < 0) {
          parts.push(chunk);
          continue;
        }
        parts.push(chunk.subarray(0, boundary));
        const rest = chunk.subarray(boundary + 1);
        if (rest.byteLength > 0) buffered.unshift(rest);
        return decoder.decode(concatenate(parts));
      }
    },
    async *readLines() {
      const parts: Uint8Array[] = [];
      while (true) {
        const chunk = await read();
        if (chunk === undefined) {
          if (parts.length > 0) throw new Error("The peer ended an incomplete frame.");
          return;
        }
        let rest = chunk;
        let boundary = rest.indexOf(lineFeed);
        while (boundary >= 0) {
          parts.push(rest.subarray(0, boundary));
          yield decoder.decode(concatenate(parts.splice(0)));
          rest = rest.subarray(boundary + 1);
          boundary = rest.indexOf(lineFeed);
        }
        if (rest.byteLength > 0) parts.push(rest);
      }
    },
    async close(options) {
      await stream.close({ signal: options?.signal });
    },
    abort(reason) {
      stream.abort(reason);
    },
  };
  return bytes;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function requireWritableData(value: unknown): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new Error("A byte stream may only send byte arrays.");
  }
}

async function waitForDrain(stream: Stream, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const settle = () => {
      stream.removeEventListener("drain", onDrain);
      signal?.removeEventListener("abort", onAbort);
    };
    const onDrain = () => {
      settle();
      resolve();
    };
    const onAbort = () => {
      settle();
      reject(signal?.reason ?? new Error("The byte stream write was aborted."));
    };
    stream.addEventListener("drain", onDrain, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
