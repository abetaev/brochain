import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p, type Libp2p, type Libp2pOptions } from "libp2p";
import { createByteStream, type ByteStream } from "./byte-stream.ts";
import {
  createPeer as createManagedPeer,
  destinationPeerId,
  isUsableConnection,
  usableConnection,
  type ManagedPeer,
  type Peer,
} from "./peer.ts";
import { answerRpc, remoteService, rpcProtocol } from "./rpc.ts";
import {
  createRegistry,
  registryServiceName,
  type Registry,
  validateServiceNames,
} from "./services/registry.ts";

export type { Peer } from "./peer.ts";
export type { PromisedMethods } from "./rpc.ts";
export type { ByteStream } from "./byte-stream.ts";

export type PeerEvent = "connected" | "disconnected" | "addresses" | "services";

export interface Protocol {
  readonly id: string;
  readonly maxInboundStreams?: number;
  readonly maxOutboundStreams?: number;
}

export interface NetworkService {
  readonly rpc?: object;
  readonly protocols?: Readonly<Record<string, (stream: ByteStream) => Promise<void>>>;
}

export interface NetworkServiceFactory {
  (peer: Peer, network: Network): NetworkService;
  readonly protocols?: readonly Protocol[];
}

export type NetworkServiceFactories = Readonly<Record<string, NetworkServiceFactory>>;
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

interface PeerState {
  readonly managed: ManagedPeer;
  readonly published: Map<string, NetworkService>;
  ready: boolean;
}

export default async function createNetwork(
  configuration: NetworkConfiguration,
  suppliedFactories: NetworkServiceFactories = {},
  shouldPublish: ServicePublication = () => true,
): Promise<Network> {
  validateFactories(suppliedFactories);

  const node = await createLibp2p({ ...configuration, start: false });
  const localId = node.peerId.toString();
  const peerStates = new Map<string, PeerState>();
  const pendingConnections = new Map<string, PendingConnection>();
  const pendingAuthentications = new Map<string, Promise<Peer>>();
  const peerListeners = new Set<(peer: Peer, event: PeerEvent) => void>();
  const lifetime = new AbortController();
  const protocolServices = new Map<string, string>();
  let shutdown: Promise<void> | undefined;

  const registryFactory: NetworkServiceFactory = (peer) => ({
    rpc: createRegistry(() => [...requiredState(peer).published.keys()]),
  });
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
        const existing = peerState(knownId);
        if (existing !== undefined) {
          updateAddresses(existing, addresses);
          return existing.managed.peer;
        }
        const peer = constructPeer(knownId);
        addAddresses(peer, addresses);
        return peer.peer;
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
      for (const id of [...peerStates.keys()]) disconnectPeer(id);
      return [...peerStates.values()]
        .filter(({ ready }) => ready)
        .map(({ managed }) => managed.peer);
    },
    services: () => supportedServices,
    publish(peer, serviceName, enabled) {
      setPublished(requiredState(peer), serviceName, enabled);
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

  function requiredState(peer: Peer): PeerState {
    const state = peerStates.get(peer.id);
    if (state === undefined || state.managed.peer !== peer) {
      throw new Error("This peer does not belong to the Network connection.");
    }
    return state;
  }

  function peerState(id: string): PeerState | undefined {
    const state = peerStates.get(id);
    if (state === undefined) return undefined;
    if (usableConnection(node, id) !== undefined) return state;
    deactivatePeer(id, state);
    return undefined;
  }

  function constructPeer(id: string): ManagedPeer {
    if (id === localId) throw new Error("The local peer cannot be created as a remote peer.");
    return createManagedPeer(
      node,
      id,
      connectManagedPeer,
      refreshPeerServices,
      (protocol) => protocolServices.get(protocol),
    );
  }

  function createService(state: PeerState, name: string): NetworkService {
    const factory = serviceFactories[name];
    if (factory === undefined) throw new Error(`Unknown network service "${name}".`);
    const service = factory(state.managed.peer, network);
    validateService(name, factory, service);
    return service;
  }

  function setPublished(state: PeerState, name: string, enabled: boolean): void {
    if (serviceFactories[name] === undefined) {
      throw new Error(`Unknown network service "${name}".`);
    }
    if (enabled) {
      if (!state.published.has(name)) state.published.set(name, createService(state, name));
    } else {
      state.published.delete(name);
    }
  }

  function prepareConnection(
    connection: Awaited<ReturnType<Libp2p["dial"]>>,
    preferred?: ManagedPeer,
  ): PeerState | undefined {
    if (!isUsableConnection(connection)) return undefined;
    const id = connection.remotePeer.toString();
    if (id === localId) return undefined;

    const retained = peerStates.get(id);
    if (retained !== undefined) return retained;

    const pending = pendingConnections.get(id)?.candidate;
    const managed = preferred?.peer.id === id
      ? preferred
      : pending?.peer.id === id
      ? pending
      : constructPeer(id);
    const state: PeerState = { managed, published: new Map(), ready: false };
    peerStates.set(id, state);

    try {
      for (const name of supportedServices) {
        if (shouldPublish(managed.peer, name)) setPublished(state, name, true);
      }
    } catch (reason) {
      peerStates.delete(id);
      throw reason;
    }
    return state;
  }

  async function initializeConnection(
    connection: Awaited<ReturnType<Libp2p["dial"]>>,
    preferred?: ManagedPeer,
  ): Promise<Peer> {
    const state = prepareConnection(connection, preferred);
    if (state === undefined) {
      throw new Error("A direct connection to this peer could not be established.");
    }
    if (state.ready) return state.managed.peer;

    state.ready = true;
    state.managed.connectionOpened();
    notifyPeer(state.managed.peer, "connected");
    return state.managed.peer;
  }

  async function readRemoteServices(id: string): Promise<readonly string[]> {
    const connection = usableConnection(node, id);
    if (connection === undefined) throw new Error("This peer is not connected.");
    const registry = remoteService<Registry>(registryServiceName, async (signal) =>
      await connection.newStream(rpcProtocol, { signal })
    );
    return validateServiceNames(await registry.list());
  }

  async function refreshPeerServices(managed: ManagedPeer): Promise<readonly string[]> {
    const state = requiredState(managed.peer);
    if (!state.ready) throw new Error("This peer is not connected.");
    try {
      const names = await readRemoteServices(managed.peer.id);
      if (managed.setServices(names)) notifyPeer(managed.peer, "services");
      return managed.peer.services();
    } catch (reason) {
      await closePeerConnections(managed.peer.id);
      throw reason;
    }
  }

  function updateAddresses(state: PeerState, addresses: readonly string[]): void {
    if (addAddresses(state.managed, addresses) && state.ready) {
      notifyPeer(state.managed.peer, "addresses");
    }
  }

  function deactivatePeer(id: string, state: PeerState): void {
    if (peerStates.get(id) !== state) return;
    peerStates.delete(id);
    state.managed.connectionClosed();
    if (state.ready) notifyPeer(state.managed.peer, "disconnected");
  }

  function disconnectPeer(id: string): void {
    const state = peerStates.get(id);
    if (state === undefined || usableConnection(node, id) !== undefined) return;
    deactivatePeer(id, state);
  }

  async function connectManagedPeer(candidate: ManagedPeer): Promise<Peer> {
    const id = candidate.peer.id;
    const connected = peerState(id);
    if (connected?.ready === true) {
      updateAddresses(connected, candidate.peer.addresses());
      return connected.managed.peer;
    }

    const existingConnection = usableConnection(node, id);
    if (existingConnection !== undefined) {
      return await initializeConnection(existingConnection, candidate);
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
      const peer = await initializeConnection(connection, candidate);
      updateAddresses(requiredState(peer), candidate.peer.addresses());
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
      const peer = await initializeConnection(connection);
      updateAddresses(requiredState(peer), addresses);
      return peer;
    } catch (reason) {
      await closePeerConnections(id);
      throw reason;
    }
  }

  function rpcService(state: PeerState, name: string): object | undefined {
    return state.published.get(name)?.rpc;
  }

  async function closePeerConnections(id: string): Promise<void> {
    await Promise.allSettled(node.getConnections()
      .filter((connection) => connection.remotePeer.toString() === id)
      .map(async (connection) => await connection.close()));
    const state = peerStates.get(id);
    if (state !== undefined) deactivatePeer(id, state);
  }

  async function stopNetwork(): Promise<void> {
    lifetime.abort();
    try {
      await node.stop();
    } finally {
      for (const [id, state] of peerStates) deactivatePeer(id, state);
      peerListeners.clear();
    }
  }

  node.addEventListener("connection:open", (event) => {
    if (!isUsableConnection(event.detail)) return;
    void initializeConnection(event.detail).catch(async () => {
      await closePeerConnections(event.detail.remotePeer.toString());
    });
  }, { signal: lifetime.signal });
  node.addEventListener("connection:close", (event) => {
    disconnectPeer(event.detail.remotePeer.toString());
  }, { signal: lifetime.signal });
  node.addEventListener("peer:identify", (event) => {
    const id = event.detail.peerId.toString();
    if (id === localId) return;
    const state = peerStates.get(id);
    if (state === undefined) return;

    let changed = false;
    for (const address of event.detail.listenAddrs) {
      try {
        changed = state.managed.addAddress(address.toString()) || changed;
      } catch {
        // A peer may only advertise addresses that identify its authenticated identity.
      }
    }
    if (changed && state.ready) notifyPeer(state.managed.peer, "addresses");
  }, { signal: lifetime.signal });
  try {
    for (const [serviceName, factory] of Object.entries(serviceFactories)) {
      for (const protocol of factory.protocols ?? []) {
        if (protocolServices.has(protocol.id)) {
          throw new Error(`A byte-stream protocol named "${protocol.id}" is already provided.`);
        }
        protocolServices.set(protocol.id, serviceName);
        await node.handle(
          protocol.id,
          async (stream, connection) => {
            if (!isUsableConnection(connection)) {
              stream.abort(new Error("Byte streams require a direct connection."));
              return;
            }
            const state = prepareConnection(connection);
            const accept = state?.published.get(serviceName)?.protocols?.[protocol.id];
            if (accept === undefined) {
              stream.abort(new Error("This byte-stream service is not available to the peer."));
              return;
            }
            try {
              await accept(createByteStream(stream));
            } catch (reason) {
              if (stream.status !== "closed" && stream.status !== "aborted") {
                stream.abort(asError(reason));
              }
            }
          },
          {
            signal: lifetime.signal,
            maxInboundStreams: protocol.maxInboundStreams,
            maxOutboundStreams: protocol.maxOutboundStreams,
          },
        );
      }
    }
    await node.handle(
      rpcProtocol,
      async (stream, connection) => {
        if (!isUsableConnection(connection)) {
          stream.abort(new Error("RPC requires a direct connection."));
          return;
        }
        const state = prepareConnection(connection);
        if (state === undefined) {
          stream.abort(new Error("RPC requires an authenticated remote peer."));
          return;
        }
        await answerRpc(stream, (name) => rpcService(state, name));
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
    if (factory.protocols !== undefined && !Array.isArray(factory.protocols)) {
      throw new Error(`The network service factory "${name}" has invalid protocols.`);
    }
    for (const protocol of factory.protocols ?? []) validateProtocol(protocol);
  }
}

function validateService(
  name: string,
  factory: NetworkServiceFactory,
  service: NetworkService,
): void {
  if (typeof service !== "object" || service === null || Array.isArray(service)) {
    throw new Error(`The network service "${name}" must be an object.`);
  }
  if (service.rpc === undefined && (factory.protocols?.length ?? 0) === 0) {
    throw new Error(`The network service "${name}" must provide RPC or a protocol.`);
  }
  if (service.rpc !== undefined) validateRpcService(name, service.rpc);
  for (const protocol of factory.protocols ?? []) {
    if (typeof service.protocols?.[protocol.id] !== "function") {
      throw new Error(`The network service "${name}" must handle "${protocol.id}".`);
    }
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

function validateProtocol(protocol: Protocol): void {
  if (typeof protocol !== "object" || protocol === null || Array.isArray(protocol)) {
    throw new Error("Every byte-stream protocol must be an object.");
  }
  if (typeof protocol.id !== "string" || protocol.id.length === 0) {
    throw new Error("Every byte-stream protocol must have an identifier.");
  }
  validateStreamLimit(protocol.id, "inbound", protocol.maxInboundStreams);
  validateStreamLimit(protocol.id, "outbound", protocol.maxOutboundStreams);
}

function validateStreamLimit(
  protocol: string,
  direction: string,
  limit: number | undefined,
): void {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(`The ${direction} limit for "${protocol}" must be a positive integer.`);
  }
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}
