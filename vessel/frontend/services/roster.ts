import { multiaddr } from "@multiformats/multiaddr";
import {
  discoveryServiceName,
  validateDiscoveredPeers,
  validateDiscoveryUpdate,
  type DiscoveredPeer,
  type DiscoveryService,
} from "@c/backend/network/services/discovery";
import type { Peer } from "@c/backend/network";
import {
  identityServiceName,
  loadIdentity,
  validateIdentity,
  type Identity,
  type IdentityService,
} from "@v/backend/network/services/identity";
import type { Session } from "@v/backend/session";
import signals from "@c/backend/signals";
import type { Subscription } from "@c/backend/signals";

export interface RosterEntry {
  readonly peerId: string;
  readonly peer?: Peer;
  readonly online: boolean;
  readonly identity?: Identity;
  readonly name: string;
  readonly addresses: readonly string[];
}

export type RosterUpdate = Readonly<
  | { type: "set"; entry: RosterEntry }
  | { type: "remove"; peerId: string }
>;

export interface Roster {
  readonly updates: Subscription<RosterUpdate>;
  list(): readonly RosterEntry[];
  get(peerId: string): RosterEntry | undefined;
  refresh(): Promise<void>;
}

const rosterServiceName = "roster";
const identityPrefix = "peers/";
const identitySuffix = ".identity";

export async function createRoster(session: Session): Promise<Roster> {
  const network = session.network();
  const persisted = session.storage({ persistent: true })
    .service(rosterServiceName)
    .kv<unknown>();
  const identities = new Map<string, Identity>();
  const connected = new Map<string, Peer>();
  const discovered = new Map<string, readonly string[]>();
  const discoveryProviders = new Map<string, () => void>();
  const entries = new Map<string, RosterEntry>();
  const updates = signals.channel<RosterUpdate>();

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
    const peer = connected.get(peerId);
    const addresses = peer?.addresses() ?? discovered.get(peerId);
    const identity = identities.get(peerId);
    if (addresses === undefined && identity === undefined) {
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
      addresses: Object.freeze([...(addresses ?? [])]),
    });
    entries.set(peerId, next);
    updates.publish({ type: "set", entry: next });
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

  function applyDiscovered(candidate: DiscoveredPeer): void {
    if (candidate.peerId === network.id) return;
    const addresses = candidate.addresses.flatMap((address) => {
      const identified = identifyAddress(address);
      return identified?.peerId === candidate.peerId ? [identified.address] : [];
    });
    const available = [...new Set(addresses)];
    if (available.length === 0) return;
    discovered.set(candidate.peerId, Object.freeze(available));
    publish(candidate.peerId);
  }

  function removeDiscovered(peerId: string): void {
    discovered.delete(peerId);
    publish(peerId);
  }

  function applyDiscoveryList(value: unknown): void {
    const peers = validateDiscoveredPeers(value);
    const present = new Set(peers.map(({ peerId }) => peerId));
    for (const peer of peers) applyDiscovered(peer);
    for (const peerId of [...discovered.keys()]) {
      if (!present.has(peerId)) removeDiscovered(peerId);
    }
  }

  async function refreshDiscovery(peer: Peer): Promise<void> {
    try {
      applyDiscoveryList(
        await peer.service<DiscoveryService>(discoveryServiceName).remote.list(),
      );
    } catch {
      // Existing observations remain when Discovery is temporarily unavailable.
    }
  }

  function applyDiscoveryUpdate(value: unknown): void {
    try {
      const update = validateDiscoveryUpdate(value);
      if (update.type === "set") applyDiscovered(update.peer);
      else removeDiscovered(update.peerId);
    } catch {
      // Invalid remote observations do not affect the current projection.
    }
  }

  async function applyServices(peer: Peer, services: readonly string[]): Promise<void> {
    await refreshIdentity(peer, services);
    if (!services.includes(discoveryServiceName)) {
      discoveryProviders.get(peer.id)?.();
      discoveryProviders.delete(peer.id);
      return;
    }
    if (!discoveryProviders.has(peer.id)) {
      discoveryProviders.set(
        peer.id,
        peer.service<DiscoveryService>(discoveryServiceName)
          .events.subscribe(applyDiscoveryUpdate),
      );
    }
    await refreshDiscovery(peer);
  }

  async function attach(peer: Peer): Promise<void> {
    try {
      await applyServices(peer, await peer.refreshServices());
    } catch {
      // The connected peer is removed when Registry is unavailable.
    }
  }

  const initial = network.connectedPeers();
  for (const peer of initial) {
    connected.set(peer.id, peer);
    publish(peer.id);
  }
  network.updates.subscribe((update) => {
    if (update.type === "disconnected") {
      connected.delete(update.peerId);
      const stopDiscovery = discoveryProviders.get(update.peerId);
      discoveryProviders.delete(update.peerId);
      stopDiscovery?.();
      if (stopDiscovery !== undefined) {
        for (const peerId of [...discovered.keys()]) removeDiscovered(peerId);
      }
      publish(update.peerId);
      return;
    }
    const { peer } = update;
    connected.set(peer.id, peer);
    publish(peer.id);
    if (update.type === "connected") void attach(peer);
    else if (update.type === "services") void applyServices(peer, peer.services());
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
      await Promise.all(network.connectedPeers().map(attach));
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
