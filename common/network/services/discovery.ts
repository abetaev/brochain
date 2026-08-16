import type { Peer, ServiceDefinition } from "../peer.ts";
import type { PeerService } from "../rpc.ts";

export interface Discovery {
  list(): Promise<readonly string[]>;
}

interface DiscoveryRpc extends PeerService<typeof discoveryServiceName> {
  list(): readonly string[];
}

export interface DiscoveryService extends ServiceDefinition<DiscoveryRpc, Discovery> {}

export const discoveryServiceName = "discovery";

export function createDiscovery(
  connectedPeers: () => readonly Peer[],
): DiscoveryService {
  return {
    name: discoveryServiceName,
    serve(requester): DiscoveryRpc {
      return {
        name: discoveryServiceName,
        list: () => connectedPeers()
          .filter((peer) => peer.id !== requester.id && peer.isConnected())
          .flatMap((peer) => peer.addresses()),
      };
    },
    gateway(_peer, remote): Discovery {
      return {
        async list() {
          const addresses: unknown = await remote.list();
          if (!Array.isArray(addresses) || !addresses.every((address) =>
            typeof address === "string"
          )) {
            throw new Error("Peer returned invalid discovery addresses.");
          }
          return [...addresses];
        },
      };
    },
  };
}
