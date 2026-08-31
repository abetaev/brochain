import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p, type Libp2p, type Libp2pOptions } from "libp2p";
import { createByteStream } from "./byte-stream.ts";
import { answerData, dataProtocol, type Stream } from "./data.ts";
import { answerEvents, eventsProtocol } from "./events.ts";
import {
  createPeer as createManagedPeer,
  destinationPeerId,
  isUsableConnection,
  usableConnection,
  type ManagedPeer,
  type Peer,
} from "./peer.ts";
import { answerRpc, remoteService, rpcProtocol } from "./rpc.ts";
import type { Channel } from "../channel.ts";
import type {
  HostedNetworkService,
  NetworkServiceFactories,
  NetworkServiceFactory,
} from "./service.ts";
import {
  createRegistry,
  registryServiceName,
  type RegistryMethods,
  validateServiceNames,
} from "./services/registry.ts";

export type { Peer } from "./peer.ts";
export { createStream } from "./data.ts";
export type { DataSource, Stream } from "./data.ts";
export type {
  AtLeastOne,
  Methods,
  NetworkService,
  NetworkServiceFactories,
  NetworkServiceFactory,
  RPC,
} from "./service.ts";

export type PeerEvent = "connected" | "disconnected" | "addresses" | "services";

export type NetworkConfiguration = Omit<Libp2pOptions, "start">;
export type ServicePublication = (peer: Peer, serviceName: string) => boolean;

export interface Network {
  readonly id: string;
  addresses(): readonly string[];
  createPeer(address: string, ...alternates: readonly string[]): Promise<Peer>;
  connectedPeers(): readonly Peer[];
  services(): readonly string[];
  publish(peer: Peer, serviceName: string, enabled: boolean): void;
  subscribe(listener: (peer: Peer, event: PeerEvent) => void): () => void;
  close(): Promise<void>;
}

interface PendingConnection {
  readonly candidate: ManagedPeer;
  readonly completion: Promise<Peer>;
}

export default async function createNetwork(
  configuration: NetworkConfiguration,
  suppliedFactories: NetworkServiceFactories = {},
  shouldPublish: ServicePublication = () => true,
): Promise<Network> {
  validateFactories(suppliedFactories);

  const node = await createLibp2p({ ...configuration, start: false });
  const localId = node.peerId.toString();
  const peers = new Map<string, ManagedPeer>();
  const pendingConnections = new Map<string, PendingConnection>();
  const pendingAuthentications = new Map<string, Promise<Peer>>();
  const peerListeners = new Set<(peer: Peer, event: PeerEvent) => void>();
  const lifetime = new AbortController();
  let shutdown: Promise<void> | undefined;

  const registryFactory: NetworkServiceFactory = (peer) =>
    createRegistry(() => requiredPeer(peer).hostedServices());
  const serviceFactories: NetworkServiceFactories = Object.freeze({
    [registryServiceName]: registryFactory,
    ...suppliedFactories,
  });
  const supportedServices = Object.freeze(Object.keys(serviceFactories));

  const network: Network = {
    id: localId,
    addresses: () => Object.freeze(node.getMultiaddrs().map((address) => address.toString())),
    async createPeer(address, ...alternates) {
      const addresses = [address, ...alternates].map((entry) => multiaddr(entry).toString());
      const identities = new Set(addresses.map(destinationPeerId).filter(isDefined));
      if (identities.size > 1) throw new Error("Peer addresses identify different peers.");

      const knownId = identities.values().next().value;
      if (knownId !== undefined) {
        if (knownId === localId) {
          throw new Error("The local peer cannot be created as a remote peer.");
        }
        const existing = peers.get(knownId);
        if (existing !== undefined) {
          updateAddresses(existing, addresses);
          return existing.peer;
        }
        const candidate = constructPeer(knownId);
        addAddresses(candidate, addresses);
        return candidate.peer;
      }

      const key = [...addresses].sort().join("\n");
      let authentication = pendingAuthentications.get(key);
      if (authentication === undefined) {
        authentication = authenticateAddresses(addresses);
        pendingAuthentications.set(key, authentication);
        void authentication.finally(() => {
          if (pendingAuthentications.get(key) === authentication) {
            pendingAuthentications.delete(key);
          }
        }).catch(() => {});
      }
      return await authentication;
    },
    connectedPeers() {
      return Object.freeze([...peers.values()]
        .map(({ peer }) => peer)
        .filter((peer) => peer.isConnected()));
    },
    services: () => supportedServices,
    publish(peer, serviceName, enabled) {
      setPublished(requiredPeer(peer), serviceName, enabled);
    },
    subscribe(listener) {
      peerListeners.add(listener);
      return () => peerListeners.delete(listener);
    },
    async close() {
      shutdown ??= stopNetwork();
      await shutdown;
    },
  };

  function notifyPeer(peer: Peer, event: PeerEvent): void {
    for (const listener of peerListeners) listener(peer, event);
  }

  function requiredPeer(peer: Peer): ManagedPeer {
    const managed = peers.get(peer.id);
    if (managed === undefined || managed.peer !== peer) {
      throw new Error("This peer does not belong to the Network connection.");
    }
    return managed;
  }

  function constructPeer(id: string): ManagedPeer {
    if (id === localId) throw new Error("The local peer cannot be created as a remote peer.");
    return createManagedPeer(
      node,
      id,
      connectManagedPeer,
      refreshPeerServices,
    );
  }

  function setPublished(managed: ManagedPeer, name: string, enabled: boolean): void {
    const factory = serviceFactories[name];
    if (factory === undefined) throw new Error(`Unknown network service "${name}".`);
    if (!enabled) {
      managed.remove(name);
      return;
    }
    if (managed.hosted(name) !== undefined) return;
    validateService(name, managed.host(name, factory));
  }

  function initializeConnection(
    connection: Awaited<ReturnType<Libp2p["dial"]>>,
    preferred?: ManagedPeer,
  ): Peer {
    if (!isUsableConnection(connection)) {
      throw new Error("A direct connection to this peer could not be established.");
    }
    const id = connection.remotePeer.toString();
    if (id === localId) {
      throw new Error("The local peer cannot be created as a remote peer.");
    }

    const retained = peers.get(id);
    if (retained !== undefined) return retained.peer;

    const pending = pendingConnections.get(id)?.candidate;
    const managed = preferred?.peer.id === id
      ? preferred
      : pending?.peer.id === id
      ? pending
      : constructPeer(id);
    peers.set(id, managed);

    try {
      for (const name of supportedServices) {
        if (shouldPublish(managed.peer, name)) setPublished(managed, name, true);
      }
    } catch (reason) {
      peers.delete(id);
      throw reason;
    }

    managed.connected();
    notifyPeer(managed.peer, "connected");
    return managed.peer;
  }

  async function readRemoteServices(id: string): Promise<readonly string[]> {
    const connection = usableConnection(node, id);
    if (connection === undefined) throw new Error("This peer is not connected.");
    const registry = remoteService<RegistryMethods>(registryServiceName, async (signal) =>
      await connection.newStream(rpcProtocol, { signal })
    );
    return validateServiceNames(await registry.list());
  }

  async function refreshPeerServices(managed: ManagedPeer): Promise<readonly string[]> {
    requiredPeer(managed.peer);
    if (!managed.peer.isConnected()) throw new Error("This peer is not connected.");
    try {
      const names = await readRemoteServices(managed.peer.id);
      if (managed.setServices(names)) notifyPeer(managed.peer, "services");
      return managed.peer.services();
    } catch (reason) {
      await closePeerConnections(managed.peer.id);
      throw reason;
    }
  }

  function updateAddresses(managed: ManagedPeer, addresses: readonly string[]): void {
    if (addAddresses(managed, addresses) && peers.get(managed.peer.id) === managed) {
      notifyPeer(managed.peer, "addresses");
    }
  }

  function deactivatePeer(id: string, managed: ManagedPeer, reason: Error): void {
    if (peers.get(id) !== managed) return;
    peers.delete(id);
    managed.close(reason);
    notifyPeer(managed.peer, "disconnected");
  }

  function disconnectPeer(id: string): void {
    const managed = peers.get(id);
    if (managed === undefined || usableConnection(node, id) !== undefined) return;
    deactivatePeer(id, managed, new Error("The peer disconnected."));
  }

  async function connectManagedPeer(candidate: ManagedPeer): Promise<Peer> {
    const id = candidate.peer.id;
    const connected = peers.get(id);
    if (connected !== undefined && connected.peer.isConnected()) {
      updateAddresses(connected, candidate.peer.addresses());
      return connected.peer;
    }

    const existingConnection = usableConnection(node, id);
    if (existingConnection !== undefined) {
      return initializeConnection(existingConnection, candidate);
    }

    const pending = pendingConnections.get(id);
    if (pending !== undefined) return await pending.completion;
    if (candidate.peer.addresses().length === 0) {
      throw new Error("This peer has no known address.");
    }

    const completion = dialCandidate(candidate);
    const entry = { candidate, completion };
    pendingConnections.set(id, entry);
    void completion.finally(() => {
      if (pendingConnections.get(id) === entry) pendingConnections.delete(id);
    }).catch(() => {});
    return await completion;
  }

  async function dialCandidate(candidate: ManagedPeer): Promise<Peer> {
    const id = candidate.peer.id;
    const connection = await node.dial(candidate.peer.addresses().map(multiaddr), {
      signal: lifetime.signal,
    });
    if (connection.remotePeer.toString() !== id) {
      await connection.close();
      disconnectPeer(connection.remotePeer.toString());
      throw new Error("The connected peer does not match its address.");
    }
    if (!isUsableConnection(connection)) {
      await connection.close();
      disconnectPeer(id);
      throw new Error("A direct connection to this peer could not be established.");
    }

    try {
      const peer = initializeConnection(connection, candidate);
      updateAddresses(requiredPeer(peer), candidate.peer.addresses());
      return peer;
    } catch (reason) {
      await closePeerConnections(id);
      throw reason;
    }
  }

  async function authenticateAddresses(addresses: readonly string[]): Promise<Peer> {
    const connection = await node.dial(addresses.map(multiaddr), { signal: lifetime.signal });
    const id = connection.remotePeer.toString();
    if (id === localId) {
      await connection.close();
      throw new Error("The local peer cannot be created as a remote peer.");
    }
    if (!isUsableConnection(connection)) {
      await connection.close();
      disconnectPeer(id);
      throw new Error("A direct connection to this peer could not be established.");
    }

    try {
      const peer = initializeConnection(connection);
      updateAddresses(requiredPeer(peer), addresses);
      return peer;
    } catch (reason) {
      await closePeerConnections(id);
      throw reason;
    }
  }

  function rpcService(managed: ManagedPeer, name: string): object | undefined {
    return managed.hosted(name)?.remote;
  }

  function eventService(managed: ManagedPeer, name: string): Channel<unknown> | undefined {
    return managed.hosted(name)?.events as Channel<unknown> | undefined;
  }

  function dataService(managed: ManagedPeer, name: string): Stream | undefined {
    return managed.hosted(name)?.data;
  }

  async function closePeerConnections(id: string): Promise<void> {
    await Promise.allSettled(node.getConnections()
      .filter((connection) => connection.remotePeer.toString() === id)
      .map(async (connection) => await connection.close()));
    const managed = peers.get(id);
    if (managed !== undefined) {
      deactivatePeer(id, managed, new Error("The peer disconnected."));
    }
  }

  async function stopNetwork(): Promise<void> {
    lifetime.abort();
    try {
      await node.stop();
    } finally {
      const reason = new Error("The Network was closed.");
      for (const [id, managed] of [...peers]) deactivatePeer(id, managed, reason);
      peerListeners.clear();
    }
  }

  node.addEventListener("connection:open", (event) => {
    if (!isUsableConnection(event.detail)) return;
    try {
      initializeConnection(event.detail);
    } catch {
      void closePeerConnections(event.detail.remotePeer.toString());
    }
  }, { signal: lifetime.signal });
  node.addEventListener("connection:close", (event) => {
    disconnectPeer(event.detail.remotePeer.toString());
  }, { signal: lifetime.signal });
  node.addEventListener("peer:identify", (event) => {
    const id = event.detail.peerId.toString();
    if (id === localId) return;
    const managed = peers.get(id);
    if (managed === undefined) return;

    let changed = false;
    for (const address of event.detail.listenAddrs) {
      try {
        changed = managed.addAddress(address.toString()) || changed;
      } catch {
        // A peer may only advertise addresses that identify its authenticated identity.
      }
    }
    if (changed) notifyPeer(managed.peer, "addresses");
  }, { signal: lifetime.signal });
  try {
    await node.handle(
      rpcProtocol,
      async (stream, connection) => {
        let managed: ManagedPeer;
        try {
          managed = requiredPeer(initializeConnection(connection));
        } catch {
          stream.abort(new Error("RPC requires an authenticated remote peer."));
          return;
        }
        await answerRpc(stream, (name) => rpcService(managed, name));
      },
      { signal: lifetime.signal },
    );
    await node.handle(
      eventsProtocol,
      async (stream, connection) => {
        let managed: ManagedPeer;
        try {
          managed = requiredPeer(initializeConnection(connection));
        } catch {
          stream.abort(new Error("Events require an authenticated remote peer."));
          return;
        }
        await answerEvents(
          createByteStream(stream),
          (name) => eventService(managed, name),
          (name, close) => managed.trackEventFeed(name, close),
        );
      },
      { signal: lifetime.signal },
    );
    await node.handle(
      dataProtocol,
      async (stream, connection) => {
        let managed: ManagedPeer;
        try {
          managed = requiredPeer(initializeConnection(connection));
        } catch {
          stream.abort(new Error("Data transfers require an authenticated remote peer."));
          return;
        }
        await answerData(createByteStream(stream), (name) => dataService(managed, name));
      },
      { signal: lifetime.signal },
    );
    await node.start();
  } catch (reason) {
    lifetime.abort();
    await Promise.allSettled([node.stop()]);
    throw reason;
  }

  return network;
}

function addAddresses(peer: ManagedPeer, addresses: readonly string[]): boolean {
  let changed = false;
  for (const address of addresses) changed = peer.addAddress(address) || changed;
  return changed;
}

function isDefined<Value>(value: Value | undefined): value is Value {
  return value !== undefined;
}

function validateFactories(factories: NetworkServiceFactories): void {
  for (const [name, factory] of Object.entries(factories)) {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("Every network service must have a name.");
    }
    if (typeof factory !== "function") {
      throw new Error(`The network service factory "${name}" must be a function.`);
    }
  }
}

function validateService(
  name: string,
  service: HostedNetworkService,
): void {
  if (typeof service !== "object" || service === null || Array.isArray(service)) {
    throw new Error(`The network service "${name}" must be an object.`);
  }
  if (
    service.remote === undefined &&
    service.events === undefined &&
    service.data === undefined
  ) {
    throw new Error(`The network service "${name}" must provide an interaction.`);
  }
  if (service.remote !== undefined) validateRpcService(name, service.remote);
  if (
    service.events !== undefined &&
    (typeof service.events.publish !== "function" ||
      typeof service.events.subscribe !== "function")
  ) {
    throw new Error(`The events facet of "${name}" must be a Channel.`);
  }
  if (
    service.data !== undefined &&
    (typeof service.data.accept !== "function" ||
      typeof service.data.send !== "function")
  ) {
    throw new Error(`The data facet of "${name}" must be a Stream.`);
  }
}

function validateRpcService(name: string, service: object | undefined): void {
  if (typeof service !== "object" || service === null || Array.isArray(service)) {
    throw new Error(`The RPC facet of "${name}" must be a method object.`);
  }
  if (Object.values(service).some((member) => typeof member !== "function")) {
    throw new Error(`The RPC facet of "${name}" may contain only methods.`);
  }
}
