import { createChannel, type Channel } from "../../channel.ts";
import type { Peer } from "../peer.ts";
import type { RPC } from "../service.ts";

export interface DiscoveredPeer {
  readonly peerId: string;
  readonly addresses: readonly string[];
}

export type DiscoveryUpdate = Readonly<
  | { type: "set"; peer: DiscoveredPeer }
  | { type: "remove"; peerId: string }
>;

export type DiscoveryMethods = {
  list(): readonly DiscoveredPeer[];
};

interface DiscoveryHost {
  service(requester: Peer): HostedDiscovery;
  peerChanged(
    peer: Peer,
    event: "connected" | "disconnected" | "addresses" | "services",
  ): void;
}

export const discoveryServiceName = "discovery";

export type DiscoveryService = {
  readonly remote: RPC<DiscoveryMethods>;
  readonly events: Channel<DiscoveryUpdate>;
};

type HostedDiscovery = {
  readonly remote: DiscoveryMethods;
  readonly events: Channel<DiscoveryUpdate>;
};

export function createDiscoveryHost(): DiscoveryHost {
  const peers = new Map<string, Peer>();
  const updates = new Map<string, Channel<DiscoveryUpdate>>();

  return {
    service(requester) {
      const events = createChannel<DiscoveryUpdate>();
      updates.set(requester.id, events);
      return {
        remote: {
          list: () => Object.freeze([...peers.values()]
            .filter((peer) => peer.id !== requester.id && peer.isConnected())
            .map(discoveredPeer)
            .filter((peer) => peer.addresses.length > 0)),
        },
        events,
      };
    },
    peerChanged(peer, event) {
      if (event === "services") return;
      if (event === "disconnected") {
        peers.delete(peer.id);
        updates.delete(peer.id);
      } else {
        if (peer.addresses().length === 0) return;
        peers.set(peer.id, peer);
      }
      const update: DiscoveryUpdate = event === "disconnected"
        ? { type: "remove", peerId: peer.id }
        : { type: "set", peer: discoveredPeer(peer) };

      for (const [requesterId, events] of updates) {
        if (requesterId !== peer.id) events.publish(update);
      }
    },
  };
}

export function validateDiscoveredPeers(value: unknown): readonly DiscoveredPeer[] {
  if (!Array.isArray(value)) throw new Error("Peer returned an invalid discovery list.");
  return Object.freeze(value.map(validateDiscoveredPeer));
}

function discoveredPeer(peer: Peer): DiscoveredPeer {
  return Object.freeze({
    peerId: peer.id,
    addresses: Object.freeze([...peer.addresses()]),
  });
}

export function validateDiscoveryUpdate(value: unknown): DiscoveryUpdate {
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
