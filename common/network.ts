import { multiaddr } from "@multiformats/multiaddr";
import type { Libp2p } from "libp2p";
import {
  answerRpc,
  remoteService,
  type PeerService,
  type RemoteService,
} from "./rpc.ts";

export interface Peer {
  readonly id: string;
  readonly addresses: readonly string[];
  readonly services: readonly string[];
  isConnected(): boolean;
  connect(): Promise<void>;
  subscribe(listener: (event: "connected" | "disconnected") => void): () => void;
  service<Service extends PeerService>(name: Service["name"]): RemoteService<Service>;
}

export interface Network {
  readonly id: string;
  bootstrap(): Promise<void>;
  host<Service extends PeerService>(factory: (peer: Peer) => Service): void;
  close(): Promise<void>;
}

interface PeersService extends PeerService<"peers"> {
  discover(): readonly string[];
}

export interface Registry {
  readonly peers: readonly Peer[];
  add(address: string): Peer;
  discover(force?: boolean): Promise<readonly Peer[]>;
  serve(peer: Peer): PeersService;
  subscribe(listener: (peer: Peer) => void): () => void;
}

interface ServicesService extends PeerService<"services"> {
  discover(): readonly string[];
}

const RPC_PROTOCOL = "/brochain/rpc/1.0.0";
const DISCOVERY_CACHE_MILLISECONDS = 5 * 60 * 1_000;

export async function createNetwork(
  node: Libp2p,
  bootstrapAddresses: readonly string[] = [],
  bootstrapReady?: (signal: AbortSignal) => Promise<void>,
): Promise<{ network: Network; registry: Registry }> {
  const localId = node.peerId.toString();
  const peers = new Map<string, ReturnType<typeof createPeer>>();
  const registryListeners = new Set<(peer: Peer) => void>();
  const factories: Array<(peer: Peer) => PeerService> = [];
  const bootstraps = [...bootstrapAddresses];
  const lifetime = new AbortController();
  let discovery: Promise<readonly Peer[]> | undefined;
  let discoveredAt: number | undefined;
  let shutdown: Promise<void> | undefined;
  let closed = false;

  function requireOpen(): void {
    if (closed) throw new Error("This network is closed.");
  }

  function rememberPeer(id: string, address?: string): ReturnType<typeof createPeer> {
    if (id === localId) throw new Error("The local peer cannot be retained in its registry.");
    let peer = peers.get(id);
    const retained = peer === undefined;

    if (peer === undefined) {
      peer = createPeer(node, id, lifetime.signal);
      peers.set(id, peer);
    }
    if (address !== undefined) peer.addAddress(address);
    if (retained) {
      for (const listener of registryListeners) listener(peer);
    }

    return peer;
  }

  function remember(address: string): ReturnType<typeof createPeer> {
    const normalized = normalizeAddress(address);
    return rememberPeer(peerId(normalized), normalized);
  }

  function rememberConnection(
    connection: Awaited<ReturnType<Libp2p["dial"]>>,
  ): ReturnType<typeof createPeer> {
    const id = connection.remotePeer.toString();
    const peer = rememberPeer(id);
    peer.connectionChanged();
    return peer;
  }

  function servicesFor(peer: Peer): PeerService[] {
    const implementations = factories.map((factory) => factory(peer));
    const names = ["services", ...implementations.map(({ name }) => name)];

    if (names.some((name) => typeof name !== "string" || name.length === 0)) {
      throw new Error("Every hosted peer service must have a name.");
    }
    if (new Set(names).size !== names.length) {
      throw new Error("Hosted peer service names must be unique.");
    }

    const discoveryService: ServicesService = {
      name: "services",
      discover: () => names,
    };
    return [discoveryService, ...implementations];
  }

  async function discoverPeer(peer: ReturnType<typeof createPeer>): Promise<void> {
    const names = await peer.service<ServicesService>("services").discover();
    if (!isServiceNames(names)) throw new Error("A peer returned invalid services.");
    peer.setServices(names);

    if (!names.includes("peers")) return;
    const addresses = await peer.service<PeersService>("peers").discover();
    if (!isStringArray(addresses)) throw new Error("A peer returned invalid addresses.");
    const normalized = addresses.map(normalizeAddress);
    if (normalized.some((address) => peerId(address) === localId)) {
      throw new Error("A peer returned the local peer address.");
    }
    normalized.forEach(remember);
  }

  async function performDiscovery(): Promise<readonly Peer[]> {
    discoveredAt = undefined;
    const queried = new Set<string>();
    let succeeded = false;

    while (true) {
      const connected = [...peers.values()].filter(
        (peer) => peer.isConnected() && !queried.has(peer.id),
      );
      if (connected.length === 0) break;
      connected.forEach((peer) => queried.add(peer.id));
      const results = await Promise.allSettled(connected.map(discoverPeer));
      succeeded ||= results.some(({ status }) => status === "fulfilled");
    }

    if (succeeded) discoveredAt = Date.now();

    return [...peers.values()];
  }

  const registry: Registry = {
    get peers() {
      return [...peers.values()];
    },
    add(address) {
      requireOpen();
      return remember(address);
    },
    async discover(force = false) {
      requireOpen();
      if (discovery !== undefined) return await discovery;
      if (
        !force && discoveredAt !== undefined &&
        Date.now() - discoveredAt < DISCOVERY_CACHE_MILLISECONDS
      ) {
        return [...peers.values()];
      }

      discovery = performDiscovery();
      try {
        return await discovery;
      } finally {
        discovery = undefined;
      }
    },
    serve(requester) {
      return {
        name: "peers",
        discover: () => [...peers.values()]
          .filter((peer) => peer.id !== requester.id && peer.isConnected())
          .flatMap((peer) => peer.addresses),
      };
    },
    subscribe(listener) {
      registryListeners.add(listener);
      return () => registryListeners.delete(listener);
    },
  };

  const network: Network = {
    id: localId,
    async bootstrap() {
      requireOpen();
      const results = await Promise.allSettled(
        bootstraps.map(async (address, index) => {
          const connection = await node.dial(multiaddr(address), { signal: lifetime.signal });
          const id = connection.remotePeer.toString();
          const authenticatedAddress = addressWithPeerId(address, id);
          bootstraps[index] = authenticatedAddress;
          rememberPeer(id, authenticatedAddress).connectionChanged();
        }),
      );
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map(({ reason }) => reason);

      if (failures.length === results.length && failures.length > 0) {
        throw new AggregateError(failures, "Unable to connect to a bootstrap peer.");
      }
      if (results.some(({ status }) => status === "fulfilled")) {
        await bootstrapReady?.(lifetime.signal);
      }
    },
    host(factory) {
      requireOpen();
      factories.push(factory);
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
    const peer = rememberPeer(id);
    for (const address of event.detail.listenAddrs) {
      peer.addAddress(addressWithPeerId(address.toString(), id));
    }
  }, { signal: lifetime.signal });

  try {
    await node.handle(
      RPC_PROTOCOL,
      async (stream, connection) => {
        if (!isUsableConnection(connection)) {
          stream.abort(new Error("RPC requires a direct connection."));
          return;
        }
        const peer = rememberConnection(connection);
        await answerRpc(
          stream,
          (name) => servicesFor(peer).find((service) => service.name === name),
        );
      },
      { signal: lifetime.signal },
    );
    await node.start();
  } catch (reason) {
    closed = true;
    lifetime.abort();
    throw reason;
  }

  return { network, registry };
}

function createPeer(
  node: Libp2p,
  id: string,
  lifetime: AbortSignal,
) {
  const addresses = new Set<string>();
  const services = new Set<string>();
  const listeners = new Set<(event: "connected" | "disconnected") => void>();
  let connected = hasUsableConnection(node, id);

  function connectionChanged(): void {
    const next = hasUsableConnection(node, id);
    if (next === connected) return;
    connected = next;
    const event = connected ? "connected" : "disconnected";
    for (const listener of listeners) listener(event);
  }

  const peer: Peer & {
    addAddress(address: string): void;
    setServices(names: readonly string[]): void;
    connectionChanged(): void;
  } = {
    id,
    get addresses() {
      return [...addresses];
    },
    get services() {
      return [...services];
    },
    isConnected: () => connected,
    async connect() {
      if (connected) return;
      if (addresses.size === 0) throw new Error("This peer has no known address.");
      const connection = await node.dial([...addresses].map(multiaddr), { signal: lifetime });
      if (connection.remotePeer.toString() !== id) {
        throw new Error("The connected peer does not match its address.");
      }
      connectionChanged();
      if (!connected) {
        await connection.close();
        connectionChanged();
        throw new Error("A direct connection to this peer could not be established.");
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    service<Service extends PeerService>(name: Service["name"]) {
      return remoteService<Service>(name, async (signal) => {
        const connection = usableConnection(node, id);
        if (connection === undefined) throw new Error("This peer is not connected.");
        return await connection.newStream(RPC_PROTOCOL, { signal });
      });
    },
    addAddress(address) {
      addresses.add(normalizeAddress(address));
    },
    setServices(names) {
      services.clear();
      names.forEach((name) => services.add(name));
    },
    connectionChanged,
  };

  return peer;
}

function usableConnection(node: Libp2p, id: string) {
  return node.getConnections().find((connection) =>
    connection.remotePeer.toString() === id && isUsableConnection(connection)
  );
}

function isUsableConnection(
  connection: Awaited<ReturnType<Libp2p["dial"]>>,
): boolean {
  return connection.status === "open" && connection.direct && connection.limits === undefined;
}

function hasUsableConnection(node: Libp2p, id: string): boolean {
  return usableConnection(node, id) !== undefined;
}

function normalizeAddress(address: string): string {
  const normalized = multiaddr(address).toString();
  peerId(normalized);
  return normalized;
}

function peerId(address: string): string {
  const id = multiaddr(address).getComponents()
    .filter(({ name }) => name === "p2p")
    .at(-1)?.value;
  if (id === undefined) throw new Error("A peer address must contain its peer ID.");
  return id;
}

function addressWithPeerId(address: string, id: string): string {
  const parsed = multiaddr(address);
  const addressedPeer = parsed.getComponents()
    .filter(({ name }) => name === "p2p")
    .at(-1)?.value;
  return addressedPeer === id ? parsed.toString() : parsed.encapsulate(`/p2p/${id}`).toString();
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isServiceNames(value: unknown): value is string[] {
  return isStringArray(value) && value.includes("services") &&
    value.every((name) => name.length > 0) && new Set(value).size === value.length;
}
