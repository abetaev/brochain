import { multiaddr } from "@multiformats/multiaddr";
import type { Network, Peer } from "../../common/network/index.ts";
import {
  discoveryServiceName,
  type DiscoveryService,
} from "../../common/network/services/discovery.ts";
import {
  registryServiceName,
  type RegistryService,
} from "../../common/network/services/registry.ts";

export interface Roster {
  list(): Promise<readonly Peer[]>;
  getPeer(peerId: string): Promise<Peer | undefined>;
  subscribe(listener: () => void): () => void;
}

export function createRoster(network: Network): Roster {
  async function discover(provider: Peer): Promise<readonly string[]> {
    const services = await provider
      .service<RegistryService>(registryServiceName)
      .list();
    if (!services.includes(discoveryServiceName)) {
      return [];
    }

    return await provider
      .service<DiscoveryService>(discoveryServiceName)
      .list();
  }

  async function list(): Promise<readonly Peer[]> {
    const connected = network.connectedPeers();
    const peers = new Map(connected.map((peer) => [peer.id, peer]));
    const results = await Promise.allSettled(connected.map(discover));

    for (const result of results) {
      if (result.status === "rejected") continue;
      for (const address of result.value) {
        if (!hasPeerId(address)) continue;
        try {
          const peer = await network.createPeer(address);
          if (peer.id !== network.id) peers.set(peer.id, peer);
        } catch {
          // One invalid or local address does not discard healthy providers.
        }
      }
    }

    return [...peers.values()];
  }

  return {
    list,
    async getPeer(peerId) {
      const connected = network.connectedPeers().find((peer) => peer.id === peerId);
      return connected ?? (await list()).find((peer) => peer.id === peerId);
    },
    subscribe(listener) {
      return network.subscribe(() => listener());
    },
  };
}

function hasPeerId(address: string): boolean {
  try {
    return multiaddr(address).getComponents().some(({ name }) => name === "p2p");
  } catch {
    return false;
  }
}
