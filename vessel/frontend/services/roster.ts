import { multiaddr } from "@multiformats/multiaddr";
import {
  discoveryServiceName,
  discoveryUpdatesProtocol,
  readDiscoveryUpdates,
  validateDiscoveredPeers,
  type DiscoveredPeer,
  type Discovery,
} from "@c/backend/network/services/discovery";
import {
  registryServiceName,
  validateServiceNames,
  type Registry,
} from "@c/backend/network/services/registry";
import type { ByteStream, Peer } from "@c/backend/network";
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

export type RosterUpdate = Readonly<
  | { type: "set"; entry: RosterEntry }
  | { type: "remove"; peerId: string }
>;

export interface Roster {
  readonly updates: Channel<RosterUpdate>;
  list(): readonly RosterEntry[];
  get(peerId: string): RosterEntry | undefined;
  refresh(): Promise<void>;
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
  const connected = new Map<string, Peer>();
  const discovered = new Map<string, Peer>();
  const discoveryProviders = new Set<string>();
  const entries = new Map<string, RosterEntry>();
  const updates = session.signals().channel<RosterUpdate>({}, "updates");

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

  function publish(peerId: string): void {
    const peer = connected.get(peerId) ?? discovered.get(peerId);
    const identity = identities.get(peerId);
    if (peer === undefined && identity === undefined) {
      entries.delete(peerId);
      updates.publish({ type: "remove", peerId });
      return;
    }

    const next = Object.freeze({
      peerId,
      ...(peer === undefined ? {} : { peer }),
      online: connected.has(peerId),
      ...(identity === undefined ? {} : { identity }),
      name: identity?.name ?? peerId,
    });
    entries.set(peerId, next);
    updates.publish({ type: "set", entry: next });
  }

  async function serviceNames(peer: Peer): Promise<readonly string[] | undefined> {
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
    services: readonly string[],
  ): Promise<void> {
    if (!services.includes(identityServiceName)) return;

    try {
      const identity = await loadIdentity(
        peer.service<IdentityService>(identityServiceName),
      );
      if (identities.get(peer.id)?.name === identity.name) return;
      await persisted.put(identityKey(peer.id), identity);
      identities.set(peer.id, identity);
      publish(peer.id);
    } catch {
      // The peer ID remains the display name when Identity is unavailable.
    }
  }

  async function applyDiscovered(candidate: DiscoveredPeer): Promise<void> {
    if (candidate.peerId === network.id) return;
    const addresses = candidate.addresses.flatMap((address) => {
      const identified = identifyAddress(address);
      return identified?.peerId === candidate.peerId ? [identified.address] : [];
    });
    const [first, ...alternates] = [...new Set(addresses)];
    if (first === undefined) return;

    try {
      const peer = await network.createPeer(first, ...alternates);
      if (peer.id !== candidate.peerId) return;
      discovered.set(peer.id, peer);
      publish(peer.id);
    } catch {
      // One unusable advertised peer does not hide other Roster entries.
    }
  }

  function removeDiscovered(peerId: string): void {
    discovered.delete(peerId);
    publish(peerId);
  }

  async function applyDiscoveryList(value: unknown): Promise<void> {
    const peers = validateDiscoveredPeers(value);
    const present = new Set(peers.map(({ peerId }) => peerId));
    await Promise.all(peers.map(applyDiscovered));
    for (const peerId of [...discovered.keys()]) {
      if (!present.has(peerId)) removeDiscovered(peerId);
    }
  }

  async function refreshDiscovery(peer: Peer): Promise<void> {
    try {
      await applyDiscoveryList(
        await peer.service<Discovery>(discoveryServiceName).list(),
      );
    } catch {
      // Existing observations remain when Discovery is temporarily unavailable.
    }
  }

  async function applyDiscoveryUpdates(stream: ByteStream): Promise<void> {
    try {
      for await (const update of readDiscoveryUpdates(stream)) {
        if (update.type === "set") await applyDiscovered(update.peer);
        else removeDiscovered(update.peerId);
      }
    } catch {
      // Reconnecting the provider establishes a new update stream.
    }
  }

  async function attachDiscovery(peer: Peer): Promise<void> {
    try {
      const stream = await peer.open(discoveryUpdatesProtocol);
      await refreshDiscovery(peer);
      void applyDiscoveryUpdates(stream);
    } catch {
      await refreshDiscovery(peer);
    }
  }

  async function attach(peer: Peer): Promise<void> {
    const services = await serviceNames(peer);
    if (services === undefined) return;
    await refreshIdentity(peer, services);
    if (services.includes(discoveryServiceName)) {
      discoveryProviders.add(peer.id);
      await attachDiscovery(peer);
    }
  }

  async function refreshPeer(peer: Peer): Promise<void> {
    const services = await serviceNames(peer);
    if (services === undefined) return;
    await refreshIdentity(peer, services);
    if (services.includes(discoveryServiceName)) await refreshDiscovery(peer);
  }

  const initial = network.connectedPeers();
  for (const peer of initial) {
    connected.set(peer.id, peer);
    publish(peer.id);
  }
  network.subscribe((peer, event) => {
    if (event === "connected") {
      connected.set(peer.id, peer);
      publish(peer.id);
      void attach(peer);
      return;
    }
    if (event === "disconnected") {
      connected.delete(peer.id);
      if (discoveryProviders.delete(peer.id)) {
        for (const peerId of [...discovered.keys()]) removeDiscovered(peerId);
      }
    }
    publish(peer.id);
  });
  await Promise.all(initial.map(attach));
  for (const peerId of identities.keys()) {
    if (!entries.has(peerId)) publish(peerId);
  }

  return {
    updates,
    list: () => Object.freeze([...entries.values()]),
    get: (peerId) => entries.get(peerId),
    async refresh() {
      await Promise.all(network.connectedPeers().map(refreshPeer));
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
