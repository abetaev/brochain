import { describe, expect, it, vi } from "vitest";
import type { ByteStream } from "../byte-stream.ts";
import type { Peer } from "../peer.ts";
import {
  createDiscoveryHost,
  readDiscoveryUpdates,
  validateDiscoveredPeers,
} from "./discovery.ts";

function peer(
  id: string,
  addresses: readonly string[],
  connected = true,
): Peer {
  return {
    id,
    addresses: () => addresses,
    isConnected: () => connected,
  } as Peer;
}

describe("Discovery", () => {
  it("lists connected addressed peers except the requester", () => {
    const requester = peer("requester", ["requester-address"]);
    const addressed = peer("addressed", ["first-address", "second-address"]);
    const addressless = peer("addressless", []);
    const disconnected = peer("disconnected", ["disconnected-address"], false);
    const discovery = createDiscoveryHost().service(
      requester,
      () => [requester, addressed, addressless, disconnected],
    );

    expect(discovery.list()).toEqual([{
      peerId: "addressed",
      addresses: ["first-address", "second-address"],
    }]);
  });

  it("publishes one directly applicable patch for each peer change", async () => {
    const host = createDiscoveryHost();
    const requesterStream = writableStream();
    const otherStream = writableStream();
    void host.updates.accept(peer("requester", []), requesterStream.stream);
    void host.updates.accept(peer("other", []), otherStream.stream);

    host.peerChanged(peer("requester", ["requester-address"]), "addresses");
    host.peerChanged(peer("changed", ["changed-address"]), "connected");
    host.peerChanged(peer("changed", []), "disconnected");
    await vi.waitFor(() => expect(requesterStream.writes).toHaveLength(2));

    expect(decode(requesterStream.writes)).toEqual([
      {
        type: "set",
        peer: { peerId: "changed", addresses: ["changed-address"] },
      },
      { type: "remove", peerId: "changed" },
    ]);
    expect(decode(otherStream.writes)).toEqual([
      {
        type: "set",
        peer: { peerId: "requester", addresses: ["requester-address"] },
      },
      {
        type: "set",
        peer: { peerId: "changed", addresses: ["changed-address"] },
      },
      { type: "remove", peerId: "changed" },
    ]);
  });

  it("reads framed updates and rejects invalid discovery data", async () => {
    const messages = [
      '{"type":"set","peer":{"peerId":"one","addresses":["address"]}}\n',
      '{"type":"remove","peerId":"one"}\n',
    ].join("");
    const bytes = new TextEncoder().encode(messages);
    const updates = await Array.fromAsync(readDiscoveryUpdates(readableStream([
      bytes.slice(0, 17),
      bytes.slice(17),
    ])));

    expect(updates).toEqual([
      { type: "set", peer: { peerId: "one", addresses: ["address"] } },
      { type: "remove", peerId: "one" },
    ]);
    expect(() => validateDiscoveredPeers({})).toThrow("invalid discovery list");
    expect(() => validateDiscoveredPeers([{ peerId: "", addresses: [] }]))
      .toThrow("invalid discovered peer");
  });
});

function writableStream() {
  const writes: Uint8Array[] = [];
  return {
    writes,
    stream: {
      async *[Symbol.asyncIterator]() {
        await new Promise<void>(() => {});
      },
      async write(data: Uint8Array) {
        writes.push(data);
      },
      async close() {},
      abort() {},
    } satisfies ByteStream,
  };
}

function readableStream(chunks: readonly Uint8Array[]): ByteStream {
  return {
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
    async write() {},
    async close() {},
    abort() {},
  };
}

function decode(chunks: readonly Uint8Array[]): unknown[] {
  return new TextDecoder().decode(concatenate(chunks))
    .trim()
    .split("\n")
    .map((message) => JSON.parse(message));
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
