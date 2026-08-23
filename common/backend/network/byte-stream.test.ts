import { describe, expect, it, vi } from "vitest";
import { createByteStream } from "./byte-stream.ts";

type RawStream = Parameters<typeof createByteStream>[0];

function rawStream(chunks: readonly Uint8Array[] = []): RawStream & EventTarget {
  return Object.assign(new EventTarget(), {
    writableNeedsDrain: false,
    send: vi.fn(() => true),
    close: vi.fn(async () => {}),
    abort: vi.fn(),
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  }) as unknown as RawStream & EventTarget;
}

describe("ByteStream", () => {
  it("reads bytes and forwards graceful close and abort", async () => {
    const raw = rawStream([new Uint8Array([1, 2]), new Uint8Array([3])]);
    const stream = createByteStream(raw);
    const received: number[] = [];

    for await (const bytes of stream) received.push(...bytes);
    const controller = new AbortController();
    await stream.close({ signal: controller.signal });
    const failure = new Error("cancelled");
    stream.abort(failure);

    expect(received).toEqual([1, 2, 3]);
    expect(raw.close).toHaveBeenCalledWith({ signal: controller.signal });
    expect(raw.abort).toHaveBeenCalledWith(failure);
  });

  it("waits for drain after the raw write buffer fills", async () => {
    const raw = rawStream();
    vi.mocked(raw.send).mockImplementationOnce(() => {
      raw.writableNeedsDrain = true;
      return false;
    });
    const stream = createByteStream(raw);
    let completed = false;

    const write = stream.write(new Uint8Array([1])).then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    raw.writableNeedsDrain = false;
    raw.dispatchEvent(new Event("drain"));
    await write;
    expect(completed).toBe(true);
  });

  it("does not write while the raw stream still requires drain", async () => {
    const raw = rawStream();
    raw.writableNeedsDrain = true;
    const stream = createByteStream(raw);
    const write = stream.write(new Uint8Array([1]));
    await Promise.resolve();
    expect(raw.send).not.toHaveBeenCalled();

    raw.writableNeedsDrain = false;
    raw.dispatchEvent(new Event("drain"));
    await write;
    expect(raw.send).toHaveBeenCalledOnce();
  });

  it("rejects a pending write when its signal aborts", async () => {
    const raw = rawStream();
    raw.writableNeedsDrain = true;
    const stream = createByteStream(raw);
    const controller = new AbortController();
    const write = stream.write(new Uint8Array([1]), { signal: controller.signal });

    controller.abort(new Error("stopped"));

    await expect(write).rejects.toThrow("stopped");
    expect(raw.send).not.toHaveBeenCalled();
  });
});
