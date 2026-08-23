import type { Libp2p } from "libp2p";

type Stream = Awaited<ReturnType<Libp2p["dialProtocol"]>>;

export interface ByteStream extends AsyncIterable<Uint8Array> {
  write(data: Uint8Array, options?: { readonly signal?: AbortSignal }): Promise<void>;
  close(options?: { readonly signal?: AbortSignal }): Promise<void>;
  abort(reason: Error): void;
}

export function createByteStream(stream: Stream): ByteStream {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const chunk of stream) {
        yield chunk instanceof Uint8Array ? chunk : chunk.subarray();
      }
    },
    async write(data, options) {
      requireWritableData(data);
      const signal = options?.signal;
      signal?.throwIfAborted();
      if (stream.writableNeedsDrain) await waitForDrain(stream, signal);
      if (!stream.send(data)) await waitForDrain(stream, signal);
    },
    async close(options) {
      await stream.close({ signal: options?.signal });
    },
    abort(reason) {
      stream.abort(reason);
    },
  };
}

function requireWritableData(data: Uint8Array): void {
  if (!(data instanceof Uint8Array)) {
    throw new Error("A byte stream can write only byte arrays.");
  }
}

async function waitForDrain(stream: Stream, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const drained = () => {
      cleanup();
      resolve();
    };
    const closed = () => {
      cleanup();
      reject(new Error("The byte stream closed before its pending data was written."));
    };
    const aborted = () => {
      cleanup();
      reject(signal?.reason);
    };
    const cleanup = () => {
      stream.removeEventListener("drain", drained);
      stream.removeEventListener("close", closed);
      signal?.removeEventListener("abort", aborted);
    };

    stream.addEventListener("drain", drained, { once: true });
    stream.addEventListener("close", closed, { once: true });
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted === true) aborted();
    else if (!stream.writableNeedsDrain) drained();
  });
}
