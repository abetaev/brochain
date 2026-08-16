import { multiaddr } from "@multiformats/multiaddr";
import type { Libp2p } from "libp2p";
import {
  addressWithPeerId,
  createPeer as createManagedPeer,
  destinationPeerId,
  isUsableConnection,
  type ManagedPeer,
  type Peer,
  type ServiceDefinition,
} from "./peer.ts";
import { answerRpc, rpcProtocol } from "./rpc.ts";
import { createDiscovery as createDiscoveryService } from "./services/discovery.ts";
import { createRegistryService } from "./services/registry.ts";

export type {
  Peer,
  ServiceDefinition,
  ServiceGateway,
} from "./peer.ts";
export type { PeerService, RemoteService } from "./rpc.ts";
export {
  createDiscovery,
  discoveryServiceName,
  type Discovery,
  type DiscoveryService,
} from "./services/discovery.ts";
export {
  registryServiceName,
  type Registry,
  type RegistryService,
} from "./services/registry.ts";

export interface Network {
  readonly id: string;
  createPeer(address: string, ...alternates: readonly string[]): Promise<Peer>;
  connectedPeers(): readonly Peer[];
  subscribe(listener: (peer: Peer) => void): () => void;
  host<Definition extends ServiceDefinition>(definition: Definition): void;
  close(): Promise<void>;
}

export async function createNetwork(node: Libp2p): Promise<Network> {
  const localId = node.peerId.toString();
  const peers = new Map<string, ManagedPeer>();
  const addressOwners = new Map<string, string>();
  const listeners = new Set<(peer: Peer) => void>();
  const hostedDefinitions = new Map<string, ServiceDefinition>();
  const gatewayDefinitions = new Map<string, ServiceDefinition>();
  const lifetime = new AbortController();
  let shutdown: Promise<void> | undefined;
  let closed = false;

  const registry = createRegistryService(() => [...hostedDefinitions.keys()]);
  const discovery = createDiscoveryService(() => []);
  hostedDefinitions.set(registry.name, registry);
  // Common gateways remain available even when their optional service is not hosted locally.
  gatewayDefinitions.set(registry.name, registry);
  gatewayDefinitions.set(discovery.name, discovery);

  function requireOpen(): void {
    if (closed) throw new Error("This network is closed.");
  }

  function notifyTopology(peer: Peer): void {
    for (const listener of listeners) listener(peer);
  }

  function definition(name: string): ServiceDefinition | undefined {
    return gatewayDefinitions.get(name);
  }

  function retainPeer(id: string, addresses: readonly string[]): ManagedPeer {
    if (id === localId) throw new Error("The local peer cannot be created as a remote peer.");

    const normalized = addresses.map((address) => multiaddr(address).toString());
    const authenticated = normalized.map((address) => addressWithPeerId(address, id));
    for (const address of [...normalized, ...authenticated]) {
      const owner = addressOwners.get(address);
      if (owner !== undefined && owner !== id) {
        throw new Error("Peer addresses identify different peers.");
      }
    }

    let managed = peers.get(id);
    if (managed === undefined) {
      managed = createManagedPeer(
        node,
        id,
        lifetime.signal,
        requireOpen,
        definition,
        notifyTopology,
      );
      peers.set(id, managed);
    }

    for (let index = 0; index < normalized.length; index += 1) {
      const supplied = normalized[index];
      const addressed = authenticated[index];
      if (supplied === undefined || addressed === undefined) continue;
      managed.addAddress(addressed);
      addressOwners.set(supplied, id);
      addressOwners.set(addressed, id);
    }
    managed.connectionChanged();
    return managed;
  }

  function rememberConnection(
    connection: Awaited<ReturnType<Libp2p["dial"]>>,
  ): ManagedPeer {
    const id = connection.remotePeer.toString();
    const managed = retainPeer(id, []);
    try {
      retainPeer(id, [connection.remoteAddr.toString()]);
    } catch {
      // An authenticated connection remains useful even if its advertised address conflicts.
    }
    managed.connectionChanged();
    return managed;
  }

  const network: Network = {
    id: localId,
    async createPeer(address, ...alternates) {
      requireOpen();
      const addresses = [address, ...alternates].map((entry) => multiaddr(entry).toString());
      const identities = new Set<string>();
      for (const entry of addresses) {
        const addressed = destinationPeerId(entry);
        const remembered = addressOwners.get(entry);
        if (addressed !== undefined) identities.add(addressed);
        if (remembered !== undefined) identities.add(remembered);
      }
      if (identities.size > 1) throw new Error("Peer addresses identify different peers.");

      const knownId = identities.values().next().value as string | undefined;
      if (knownId !== undefined) return retainPeer(knownId, addresses).peer;

      const connection = await node.dial(addresses.map(multiaddr), { signal: lifetime.signal });
      const id = connection.remotePeer.toString();
      if (id === localId) {
        await connection.close();
        throw new Error("The local peer cannot be created as a remote peer.");
      }
      if (!isUsableConnection(connection)) {
        await connection.close();
        throw new Error("A direct connection to this peer could not be established.");
      }

      const managed = retainPeer(id, addresses);
      managed.connectionChanged();
      if (!managed.peer.isConnected()) {
        await connection.close();
        managed.connectionChanged();
        throw new Error("A direct connection to this peer could not be established.");
      }
      return managed.peer;
    },
    connectedPeers() {
      return [...peers.values()]
        .map(({ peer }) => peer)
        .filter((peer) => peer.isConnected());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    host(service) {
      requireOpen();
      validateDefinition(service);
      if (hostedDefinitions.has(service.name)) {
        throw new Error(`A peer service named "${service.name}" is already hosted.`);
      }
      hostedDefinitions.set(service.name, service);
      gatewayDefinitions.set(service.name, service);
    },
    async close() {
      if (shutdown === undefined) {
        closed = true;
        shutdown = stopNetwork();
      }
      await shutdown;
    },
  };

  async function stopNetwork(): Promise<void> {
    try {
      await node.stop();
    } finally {
      lifetime.abort();
    }
  }

  node.addEventListener("connection:open", (event) => {
    rememberConnection(event.detail);
  }, { signal: lifetime.signal });
  node.addEventListener("connection:close", (event) => {
    peers.get(event.detail.remotePeer.toString())?.connectionChanged();
  }, { signal: lifetime.signal });
  node.addEventListener("peer:identify", (event) => {
    const id = event.detail.peerId.toString();
    if (id === localId) return;
    retainPeer(id, []);
    for (const address of event.detail.listenAddrs) {
      try {
        retainPeer(id, [address.toString()]);
      } catch {
        // Conflicting addresses must not replace an address's authenticated owner.
      }
    }
  }, { signal: lifetime.signal });

  try {
    await node.handle(
      rpcProtocol,
      async (stream, connection) => {
        if (!isUsableConnection(connection)) {
          stream.abort(new Error("RPC requires a direct connection."));
          return;
        }

        const peer = rememberConnection(connection).peer;
        await answerRpc(stream, (name) => {
          const service = hostedDefinitions.get(name);
          if (service === undefined) return undefined;
          const implementation = service.serve(peer);
          if (implementation.name !== service.name) {
            throw new Error("A hosted peer service returned a conflicting name.");
          }
          return implementation;
        });
      },
      { signal: lifetime.signal },
    );
    await node.start();
  } catch (reason) {
    closed = true;
    lifetime.abort();
    await Promise.allSettled([node.stop()]);
    throw reason;
  }

  return network;
}

function validateDefinition(definition: ServiceDefinition): void {
  if (typeof definition.name !== "string" || definition.name.length === 0) {
    throw new Error("Every hosted peer service must have a name.");
  }
  if (typeof definition.serve !== "function") {
    throw new Error("Every hosted peer service must provide an RPC implementation.");
  }
  if (definition.gateway !== undefined && typeof definition.gateway !== "function") {
    throw new Error("A peer service gateway must be a function.");
  }
}
