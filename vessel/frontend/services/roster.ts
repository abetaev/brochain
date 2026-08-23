import { multiaddr } from "@multiformats/multiaddr";
import {
  discoveryServiceName,
  validateDiscoveryAddresses,
  type Discovery,
} from "@c/backend/network/services/discovery";
import {
  registryServiceName,
  validateServiceNames,
  type Registry,
} from "@c/backend/network/services/registry";
import type { Peer } from "@c/backend/network";
import type { Session } from "@v/backend/session";
import type { Channel } from "@v/backend/signals";

export interface Roster {
  readonly invalidations: Channel<void>;
  list(): Promise<readonly Peer[]>;
  getPeer(peerId: string): Promise<Peer | undefined>;
}

export async function createRoster(session: Session): Promise<Roster> {
  const network = await session.network();
  const invalidations = session.signals().channel<void>({}, "invalidations");
  network.subscribe(() => invalidations.publish(undefined));

  async function discover(provider: Peer): Promise<readonly string[]> {
    const services = validateServiceNames(
      await provider.service<Registry>(registryServiceName).list(),
    );
    if (!services.includes(discoveryServiceName)) return [];

    return validateDiscoveryAddresses(
      await provider.service<Discovery>(discoveryServiceName).list(),
    );
  }

  async function list(): Promise<readonly Peer[]> {
    const connected = [...network.connectedPeers()];
    const peers = new Map(connected.map((peer) => [peer.id, peer]));
    const discovered = new Map<string, Set<string>>();
    const results = await Promise.allSettled(connected.map(discover));

    for (const result of results) {
      if (result.status === "rejected") continue;
      for (const address of result.value) {
        const identified = identifyAddress(address);
        if (
          identified === undefined ||
          identified.peerId === network.id ||
          peers.has(identified.peerId)
        ) {
          continue;
        }

        let addresses = discovered.get(identified.peerId);
        if (addresses === undefined) {
          addresses = new Set();
          discovered.set(identified.peerId, addresses);
        }
        addresses.add(identified.address);
      }
    }

    const creations = await Promise.allSettled(
      [...discovered].map(async ([peerId, addresses]) => {
        const [first, ...alternates] = addresses;
        if (first === undefined) return undefined;
        const peer = await network.createPeer(first, ...alternates);
        return peer.id === peerId && peer.id !== network.id ? peer : undefined;
      }),
    );
    for (const creation of creations) {
      if (creation.status === "fulfilled" && creation.value !== undefined) {
        peers.set(creation.value.id, creation.value);
      }
    }

    return [...peers.values()];
  }

  return {
    invalidations,
    list,
    async getPeer(peerId) {
      const connected = network.connectedPeers().find((peer) => peer.id === peerId);
      return connected ?? (await list()).find((peer) => peer.id === peerId);
    },
  };
}

function identifyAddress(
  address: string,
): { readonly address: string; readonly peerId: string } | undefined {
  try {
    const parsed = multiaddr(address);
    const terminal = parsed.getComponents().at(-1);
    if (terminal?.name !== "p2p" || terminal.value === undefined) return undefined;
    return { address: parsed.toString(), peerId: terminal.value };
  } catch {
    return undefined;
  }
}
