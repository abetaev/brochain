import type { ByteStream } from "../byte-stream.ts";
import type { Peer } from "../peer.ts";

export interface DiscoveredPeer {
  readonly peerId: string;
  readonly addresses: readonly string[];
}

export type DiscoveryUpdate = Readonly<
  | { type: "set"; peer: DiscoveredPeer }
  | { type: "remove"; peerId: string }
>;

export interface Discovery {
  list(): readonly DiscoveredPeer[];
}

interface DiscoveryHost {
  service(
    requester: Peer,
    connectedPeers: () => readonly Peer[],
  ): Discovery;
  readonly updates: {
    readonly id: string;
    accept(peer: Peer, stream: ByteStream): Promise<void>;
  };
  peerChanged(peer: Peer, event: "connected" | "disconnected" | "addresses"): void;
}

export const discoveryServiceName = "discovery";
export const discoveryUpdatesProtocol = "/brochain/discovery/1.0.0";

export function createDiscoveryHost(): DiscoveryHost {
  const subscribers = new Set<{ readonly peerId: string; readonly stream: ByteStream }>();

  return {
    service(requester, connectedPeers) {
      return {
        list: () => Object.freeze(connectedPeers()
          .filter((peer) => peer.id !== requester.id && peer.isConnected())
          .map(discoveredPeer)
          .filter((peer) => peer.addresses.length > 0)),
      };
    },
    updates: {
      id: discoveryUpdatesProtocol,
      async accept(peer, stream) {
        const subscriber = { peerId: peer.id, stream };
        subscribers.add(subscriber);
        try {
          for await (const _ of stream) {
            // Discovery subscribers do not send data.
          }
        } finally {
          subscribers.delete(subscriber);
        }
      },
    },
    peerChanged(peer, event) {
      if (event !== "disconnected" && peer.addresses().length === 0) return;
      const update: DiscoveryUpdate = event === "disconnected"
        ? { type: "remove", peerId: peer.id }
        : { type: "set", peer: discoveredPeer(peer) };
      const message = encodeUpdate(update);

      for (const subscriber of subscribers) {
        if (subscriber.peerId === peer.id) continue;
        void subscriber.stream.write(message).catch((reason) => {
          subscribers.delete(subscriber);
          subscriber.stream.abort(asError(reason));
        });
      }
    },
  };
}

export function validateDiscoveredPeers(value: unknown): readonly DiscoveredPeer[] {
  if (!Array.isArray(value)) throw new Error("Peer returned an invalid discovery list.");
  return Object.freeze(value.map(validateDiscoveredPeer));
}

export async function* readDiscoveryUpdates(
  stream: ByteStream,
): AsyncGenerator<DiscoveryUpdate> {
  const decoder = new TextDecoder();
  let buffered = "";

  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    let boundary = buffered.indexOf("\n");
    while (boundary >= 0) {
      const message = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 1);
      if (message.length > 0) yield validateDiscoveryUpdate(JSON.parse(message));
      boundary = buffered.indexOf("\n");
    }
  }

  buffered += decoder.decode();
  if (buffered.length > 0) {
    throw new Error("Peer ended a partial discovery update.");
  }
}

function discoveredPeer(peer: Peer): DiscoveredPeer {
  return Object.freeze({
    peerId: peer.id,
    addresses: Object.freeze([...peer.addresses()]),
  });
}

function validateDiscoveryUpdate(value: unknown): DiscoveryUpdate {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    throw new Error("Peer sent an invalid discovery update.");
  }
  if (value.type === "set" && "peer" in value) {
    return Object.freeze({ type: "set", peer: validateDiscoveredPeer(value.peer) });
  }
  if (
    value.type === "remove" &&
    "peerId" in value &&
    typeof value.peerId === "string" &&
    value.peerId.length > 0
  ) {
    return Object.freeze({ type: "remove", peerId: value.peerId });
  }
  throw new Error("Peer sent an invalid discovery update.");
}

function validateDiscoveredPeer(value: unknown): DiscoveredPeer {
  if (
    typeof value !== "object" ||
    value === null ||
    !("peerId" in value) ||
    typeof value.peerId !== "string" ||
    value.peerId.length === 0 ||
    !("addresses" in value) ||
    !Array.isArray(value.addresses) ||
    !value.addresses.every((address) => typeof address === "string")
  ) {
    throw new Error("Peer returned an invalid discovered peer.");
  }
  return Object.freeze({
    peerId: value.peerId,
    addresses: Object.freeze([...value.addresses]),
  });
}

function encodeUpdate(update: DiscoveryUpdate): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(update)}\n`);
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}
