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
import { answerRpc, rpcProtocol } from "./rpc.ts";
import { createRegistry, registryServiceName } from "./services/registry.ts";

export type { Peer } from "./peer.ts";
export type { PromisedMethods } from "./rpc.ts";
export type { ByteStream } from "./byte-stream.ts";

export interface Protocol {
  readonly id: string;
  readonly maxInboundStreams?: number;
  readonly maxOutboundStreams?: number;
  accept(peer: Peer, stream: ByteStream): Promise<void>;
}

export interface Service {
  enabled?(peer: Peer, network: Network): boolean;
  rpc?(peer: Peer, network: Network): object;
  readonly protocols?: readonly Protocol[];
}

export type Services = Readonly<Record<string, Service>>;
export type NetworkConfiguration = Omit<Libp2pOptions, "start">;

export interface Network {
  readonly id: string;
  addresses(): readonly string[];
  subscribeAddresses(listener: () => void): () => void;
  createPeer(address: string, ...alternates: readonly string[]): Promise<Peer>;
  connectedPeers(): readonly Peer[];
  provide(services: Services): Promise<void>;
  services(): Services;
  subscribe(
    listener: (peer: Peer, event: "connected" | "disconnected") => void,
  ): () => void;
  close(): Promise<void>;
}

interface PendingConnection {
  readonly candidate: ManagedPeer;
  readonly completion: Promise<Peer>;
}

export default async function createNetwork(
  configuration: NetworkConfiguration,
  initialServices: Services = {},
): Promise<Network> {
  const node = await createLibp2p({ ...configuration, start: false });
  const localId = node.peerId.toString();
  const activePeers = new Map<string, ManagedPeer>();
  const pendingConnections = new Map<string, PendingConnection>();
  const pendingAuthentications = new Map<string, Promise<Peer>>();
  const topologyListeners = new Set<(
    peer: Peer,
    event: "connected" | "disconnected",
  ) => void>();
  const addressListeners = new Set<() => void>();
  const lifetime = new AbortController();
  const serviceDefinitions = new Map<string, Service>();
  const protocolDefinitions = new Map<
    string,
    { readonly serviceName: string; readonly protocol: Protocol }
  >();
  const rpcImplementations = new WeakMap<ManagedPeer, Map<string, object>>();
  let provisioning = Promise.resolve();
  let shutdown: Promise<void> | undefined;

  function notifyTopology(
    peer: Peer,
    event: "connected" | "disconnected",
  ): void {
    for (const listener of topologyListeners) listener(peer, event);
  }

  function constructPeer(id: string): ManagedPeer {
    if (id === localId) throw new Error("The local peer cannot be created as a remote peer.");
    const managed = createManagedPeer(node, id, connectManagedPeer);
    return managed;
  }

  function isEnabled(service: Service, peer: Peer): boolean {
    return service.enabled?.(peer, network) ?? true;
  }

  function rpcService(peer: ManagedPeer, name: string): object | undefined {
    let implementations = rpcImplementations.get(peer);
    if (implementations === undefined) {
      implementations = new Map();
      rpcImplementations.set(peer, implementations);
    }

    const service = serviceDefinitions.get(name);
    const factory = service?.rpc;
    if (service === undefined || factory === undefined || !isEnabled(service, peer.peer)) {
      return undefined;
    }
    const existing = implementations.get(name);
    if (existing !== undefined) return existing;
    const implementation = factory(peer.peer, network);
    validateRpcService(name, implementation);
    implementations.set(name, implementation);
    return implementation;
  }

  async function registerServices(services: Services): Promise<void> {
    const entries = Object.entries(services);
    const additions = new Map<string, Service>();
    const protocols = new Map<
      string,
      { readonly serviceName: string; readonly protocol: Protocol }
    >();

    for (const [name, service] of entries) {
      validateService(name, service);
      if (serviceDefinitions.has(name) || additions.has(name)) {
        throw new Error(`A network service named "${name}" is already provided.`);
      }
      additions.set(name, service);
      for (const protocol of service.protocols ?? []) {
        validateProtocol(protocol);
        if (protocolDefinitions.has(protocol.id) || protocols.has(protocol.id)) {
          throw new Error(`A byte-stream protocol named "${protocol.id}" is already provided.`);
        }
        protocols.set(protocol.id, { serviceName: name, protocol });
      }
    }

    const handled: string[] = [];
    try {
      for (const { serviceName, protocol } of protocols.values()) {
        await node.handle(
          protocol.id,
          async (stream, connection) => {
            if (!isUsableConnection(connection)) {
              stream.abort(new Error("Byte streams require a direct connection."));
              return;
            }
            const active = activateConnection(connection);
            if (active === undefined) {
              stream.abort(new Error("Byte streams require an authenticated remote peer."));
              return;
            }
            const service = serviceDefinitions.get(serviceName) ?? additions.get(serviceName);
            if (service === undefined || !isEnabled(service, active.peer)) {
              stream.abort(new Error("This byte-stream service is not available to the peer."));
              return;
            }

            try {
              await protocol.accept(active.peer, createByteStream(stream));
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
        handled.push(protocol.id);
      }
    } catch (reason) {
      await Promise.allSettled(handled.map(async (id) => await node.unhandle(id)));
      throw reason;
    }

    for (const [name, service] of additions) serviceDefinitions.set(name, service);
    for (const [id, protocol] of protocols) protocolDefinitions.set(id, protocol);
  }

  function activePeer(id: string): ManagedPeer | undefined {
    const active = activePeers.get(id);
    if (active === undefined) return undefined;
    if (usableConnection(node, id) !== undefined) return active;

    deactivatePeer(id, active);
    return undefined;
  }

  function activateConnection(
    connection: Awaited<ReturnType<Libp2p["dial"]>>,
    preferred?: ManagedPeer,
  ): ManagedPeer | undefined {
    if (!isUsableConnection(connection)) return undefined;
    const id = connection.remotePeer.toString();
    if (id === localId) return undefined;

    const retained = activePeers.get(id);
    if (retained !== undefined) {
      retained.connectionOpened();
      return retained;
    }

    const pending = pendingConnections.get(id)?.candidate;
    const managed = preferred?.peer.id === id
      ? preferred
      : pending?.peer.id === id
      ? pending
      : constructPeer(id);
    activePeers.set(id, managed);
    managed.connectionOpened();
    notifyTopology(managed.peer, "connected");
    return managed;
  }

  function deactivatePeer(id: string, active: ManagedPeer): void {
    if (activePeers.get(id) !== active) return;
    activePeers.delete(id);
    active.connectionClosed();
    notifyTopology(active.peer, "disconnected");
  }

  function disconnectPeer(id: string): void {
    const active = activePeers.get(id);
    if (active === undefined || usableConnection(node, id) !== undefined) return;
    deactivatePeer(id, active);
  }

  async function connectManagedPeer(candidate: ManagedPeer): Promise<Peer> {
    const id = candidate.peer.id;
    const connected = activePeer(id);
    if (connected !== undefined) {
      addAddresses(connected, candidate.peer.addresses());
      return connected.peer;
    }

    const existingConnection = usableConnection(node, id);
    if (existingConnection !== undefined) {
      const active = activateConnection(existingConnection, candidate);
      if (active !== undefined) return active.peer;
    }

    const pending = pendingConnections.get(id);
    if (pending !== undefined) return await pending.completion;
    if (candidate.peer.addresses().length === 0) {
      throw new Error("This peer has no known address.");
    }

    let resolve!: (peer: Peer) => void;
    let reject!: (reason: unknown) => void;
    const completion = new Promise<Peer>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const entry = { candidate, completion };
    pendingConnections.set(id, entry);

    void dialCandidate(candidate).then(resolve, reject).finally(() => {
      if (pendingConnections.get(id) === entry) pendingConnections.delete(id);
    });
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

    const active = activateConnection(connection, candidate);
    if (active === undefined) {
      await connection.close();
      throw new Error("A direct connection to this peer could not be established.");
    }
    addAddresses(active, candidate.peer.addresses());
    return active.peer;
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

    const active = activateConnection(connection);
    if (active === undefined) {
      await connection.close();
      throw new Error("A direct connection to this peer could not be established.");
    }
    addAddresses(active, addresses);
    return active.peer;
  }

  const network: Network = {
    id: localId,
    addresses: () => Object.freeze(node.getMultiaddrs().map((address) => address.toString())),
    subscribeAddresses(listener) {
      addressListeners.add(listener);
      return () => addressListeners.delete(listener);
    },
    async createPeer(address, ...alternates) {
      const addresses = [address, ...alternates].map((entry) => multiaddr(entry).toString());
      const identities = new Set(addresses.map(destinationPeerId).filter(isDefined));
      if (identities.size > 1) throw new Error("Peer addresses identify different peers.");

      const knownId = identities.values().next().value;
      if (knownId !== undefined) {
        if (knownId === localId) {
          throw new Error("The local peer cannot be created as a remote peer.");
        }
        const active = activePeer(knownId);
        if (active !== undefined) {
          addAddresses(active, addresses);
          return active.peer;
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
      for (const id of [...activePeers.keys()]) disconnectPeer(id);
      return [...activePeers.values()].map(({ peer }) => peer);
    },
    async provide(services) {
      const addition = provisioning.then(async () => await registerServices(services));
      provisioning = addition.catch(() => {});
      await addition;
    },
    services() {
      return Object.freeze(Object.fromEntries(serviceDefinitions));
    },
    subscribe(listener) {
      topologyListeners.add(listener);
      return () => topologyListeners.delete(listener);
    },
    async close() {
      shutdown ??= stopNetwork();
      await shutdown;
    },
  };

  async function stopNetwork(): Promise<void> {
    lifetime.abort();
    try {
      await node.stop();
    } finally {
      for (const [id, peer] of activePeers) {
        deactivatePeer(id, peer);
      }
      topologyListeners.clear();
      addressListeners.clear();
    }
  }

  node.addEventListener("connection:open", (event) => {
    activateConnection(event.detail);
  }, { signal: lifetime.signal });
  node.addEventListener("connection:close", (event) => {
    disconnectPeer(event.detail.remotePeer.toString());
  }, { signal: lifetime.signal });
  node.addEventListener("peer:identify", (event) => {
    const id = event.detail.peerId.toString();
    if (id === localId) return;

    const connection = usableConnection(node, id);
    const active = activePeer(id) ??
      (connection === undefined ? undefined : activateConnection(connection));
    if (active === undefined) return;
    for (const address of event.detail.listenAddrs) {
      try {
        active.addAddress(address.toString());
      } catch {
        // A peer may only advertise addresses that identify its authenticated identity.
      }
    }
  }, { signal: lifetime.signal });
  node.addEventListener("self:peer:update", () => {
    for (const listener of addressListeners) listener();
  }, { signal: lifetime.signal });

  try {
    serviceDefinitions.set(registryServiceName, {
      rpc: (peer) => createRegistry(() => [...serviceDefinitions]
        .filter(([, service]) => isEnabled(service, peer))
        .map(([name]) => name)),
    });
    await registerServices(initialServices);
    await node.handle(
      rpcProtocol,
      async (stream, connection) => {
        if (!isUsableConnection(connection)) {
          stream.abort(new Error("RPC requires a direct connection."));
          return;
        }

        const active = activateConnection(connection);
        if (active === undefined) {
          stream.abort(new Error("RPC requires an authenticated remote peer."));
          return;
        }
        await answerRpc(stream, (name) => rpcService(active, name));
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

function addAddresses(peer: ManagedPeer, addresses: readonly string[]): void {
  for (const address of addresses) peer.addAddress(address);
}

function isDefined<Value>(value: Value | undefined): value is Value {
  return value !== undefined;
}

function validateService(name: string, service: Service): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Every network service must have a name.");
  }
  if (typeof service !== "object" || service === null || Array.isArray(service)) {
    throw new Error(`The network service "${name}" must be an object.`);
  }
  if (service.rpc === undefined && (service.protocols?.length ?? 0) === 0) {
    throw new Error(`The network service "${name}" must provide RPC or a protocol.`);
  }
  if (service.rpc !== undefined && typeof service.rpc !== "function") {
    throw new Error(`The network service "${name}" has an invalid RPC factory.`);
  }
  if (service.enabled !== undefined && typeof service.enabled !== "function") {
    throw new Error(`The network service "${name}" has an invalid availability predicate.`);
  }
  if (service.protocols !== undefined && !Array.isArray(service.protocols)) {
    throw new Error(`The network service "${name}" has invalid protocols.`);
  }
}

function validateRpcService(name: string, service: object): void {
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
  if (typeof protocol.accept !== "function") {
    throw new Error(`The byte-stream protocol "${protocol.id}" must accept streams.`);
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
