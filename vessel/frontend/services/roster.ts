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
import {
  identityServiceName,
  loadIdentity,
  validateIdentity,
  type Identity,
  type IdentityService,
} from "@v/backend/network/services/identity";
import type { Session } from "@v/backend/session";
import type { Channel } from "@v/backend/signals";

export interface RosterEntry {
  readonly peerId: string;
  readonly peer?: Peer;
  readonly online: boolean;
  readonly identity?: Identity;
  readonly name: string;
}

export interface Roster {
  readonly invalidations: Channel<void>;
  list(): Promise<readonly RosterEntry[]>;
  get(peerId: string): Promise<RosterEntry | undefined>;
}

const rosterServiceName = "roster";
const identityPrefix = "peers/";
const identitySuffix = ".identity";

export async function createRoster(session: Session): Promise<Roster> {
  const network = await session.network();
  const persisted = session.storage({ persistent: true })
    .peer(network.id)
    .service(rosterServiceName)
    .kv<unknown>();
  const identities = new Map<string, Identity>();
  const invalidations = session.signals().channel<void>({}, "invalidations");

  for (const [key, value] of await persisted.entries()) {
    const peerId = identityPeerId(key);
    let identity: Identity | undefined;
    if (peerId !== undefined && peerId !== network.id) {
      try {
        identity = validateIdentity(value);
      } catch {
        // Invalid persisted observations are removed below.
      }
    }

    if (peerId === undefined || identity === undefined) {
      await persisted.delete(key);
      continue;
    }
    identities.set(peerId, identity);
  }

  network.subscribe(() => invalidations.publish(undefined));

  async function services(peer: Peer): Promise<readonly string[] | undefined> {
    try {
      return validateServiceNames(
        await peer.service<Registry>(registryServiceName).list(),
      );
    } catch {
      return undefined;
    }
  }

  async function refreshIdentity(
    peer: Peer,
    serviceNames: readonly string[],
  ): Promise<void> {
    if (!serviceNames.includes(identityServiceName)) return;

    let identity: Identity;
    try {
      identity = await loadIdentity(
        peer.service<IdentityService>(identityServiceName),
      );
    } catch {
      return;
    }

    const previous = identities.get(peer.id);
    if (previous?.name !== identity.name) {
      await persisted.put(identityKey(peer.id), identity);
      identities.set(peer.id, identity);
      invalidations.publish(undefined);
    }
  }

  async function discover(
    peer: Peer,
    serviceNames: readonly string[],
  ): Promise<readonly string[]> {
    if (!serviceNames.includes(discoveryServiceName)) return [];
    try {
      return validateDiscoveryAddresses(
        await peer.service<Discovery>(discoveryServiceName).list(),
      );
    } catch {
      return [];
    }
  }

  async function inspect(peer: Peer): Promise<readonly string[]> {
    const serviceNames = await services(peer);
    if (serviceNames === undefined) return [];
    const [, addresses] = await Promise.all([
      refreshIdentity(peer, serviceNames),
      discover(peer, serviceNames),
    ]);
    return addresses;
  }

  function entry(peerId: string, peer?: Peer): RosterEntry {
    const identity = identities.get(peerId);
    return Object.freeze({
      peerId,
      ...(peer === undefined ? {} : { peer }),
      online: peer?.isConnected() ?? false,
      ...(identity === undefined ? {} : { identity }),
      name: identity?.name ?? peerId,
    });
  }

  async function list(): Promise<readonly RosterEntry[]> {
    const connected = [...network.connectedPeers()];
    const peers = new Map<string, Peer | undefined>(
      connected.map((peer) => [peer.id, peer]),
    );
    const discovered = new Map<string, Set<string>>();
    const results = await Promise.all(connected.map(inspect));

    for (const addresses of results) {
      for (const address of addresses) {
        const identified = identifyAddress(address);
        if (
          identified === undefined ||
          identified.peerId === network.id ||
          peers.has(identified.peerId)
        ) {
          continue;
        }

        let alternatives = discovered.get(identified.peerId);
        if (alternatives === undefined) {
          alternatives = new Set();
          discovered.set(identified.peerId, alternatives);
        }
        alternatives.add(identified.address);
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
    for (const peerId of identities.keys()) {
      if (!peers.has(peerId)) peers.set(peerId, undefined);
    }

    return Object.freeze(
      [...peers].map(([peerId, peer]) => entry(peerId, peer)),
    );
  }

  return {
    invalidations,
    list,
    async get(peerId) {
      const connected = network.connectedPeers().find((peer) => peer.id === peerId);
      if (connected !== undefined) {
        const serviceNames = await services(connected);
        if (serviceNames !== undefined) {
          await refreshIdentity(connected, serviceNames);
        }
        return entry(peerId, connected);
      }
      return (await list()).find((candidate) => candidate.peerId === peerId);
    },
  };
}

function identityKey(peerId: string): string {
  return `${identityPrefix}${peerId}${identitySuffix}`;
}

function identityPeerId(key: string): string | undefined {
  return peerProperty(key, identitySuffix);
}

function peerProperty(key: string, suffix: string): string | undefined {
  if (!key.startsWith(identityPrefix) || !key.endsWith(suffix)) return undefined;
  const peerId = key.slice(identityPrefix.length, -suffix.length);
  return peerId.length === 0 ? undefined : peerId;
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
