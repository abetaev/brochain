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
import {
  type Network,
  type Peer,
} from "@c/backend/network";
import type { Session } from "@v/backend/session";

export interface Roster {
  list(): Promise<readonly Peer[]>;
  getPeer(peerId: string): Promise<Peer | undefined>;
  subscribe(listener: () => void): () => void;
}

export function createRoster(session: Session): Roster {
  const listeners = new Set<() => void>();
  let stopNetwork: (() => void) | undefined;

  function observe(network: Network): void {
    if (stopNetwork !== undefined || listeners.size === 0) return;
    stopNetwork = network.subscribe(() => {
      for (const listener of [...listeners]) listener();
    });
  }

  async function accessNetwork(): Promise<Network> {
    const network = await session.network();
    observe(network);
    return network;
  }

  async function startObserving(): Promise<void> {
    try {
      await accessNetwork();
    } catch {
      // A list or peer request reports access errors and retries observation.
    }
  }

  async function discover(provider: Peer): Promise<readonly string[]> {
    const services = validateServiceNames(
      await provider.service<Registry>(registryServiceName).list(),
    );
    if (!services.includes(discoveryServiceName)) return [];

    return validateDiscoveryAddresses(
      await provider.service<Discovery>(discoveryServiceName).list(),
    );
  }

  async function load(network: Network): Promise<readonly Peer[]> {
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
    async list() {
      return await load(await accessNetwork());
    },
    async getPeer(peerId) {
      const network = await accessNetwork();
      const connected = network.connectedPeers().find((peer) => peer.id === peerId);
      return connected ?? (await load(network)).find((peer) => peer.id === peerId);
    },
    subscribe(listener) {
      listeners.add(listener);
      void startObserving();
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        stopNetwork?.();
        stopNetwork = undefined;
      };
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
