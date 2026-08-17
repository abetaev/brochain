import type { Peer } from "../peer.ts";

export interface Discovery {
  list(): readonly string[];
}

export const discoveryServiceName = "discovery";

export function createDiscovery(
  requester: Peer,
  connectedPeers: () => readonly Peer[],
): Discovery {
  return {
    list: () => connectedPeers()
      .filter((peer) => peer.id !== requester.id && peer.isConnected())
      .flatMap((peer) => peer.addresses()),
  };
}

export function validateDiscoveryAddresses(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((address) => typeof address === "string")) {
    throw new Error("Peer returned invalid discovery addresses.");
  }
  return [...value];
}
