import { multiaddr } from "@multiformats/multiaddr";
import type { Libp2p } from "libp2p";
import { createByteStream, type ByteStream } from "./byte-stream.ts";
import { cancelData, createRemoteData, dataProtocol } from "./data.ts";
import { createRemoteEvents, eventsProtocol, type RemoteEvents } from "./events.ts";
import { remoteService, rpcProtocol } from "./rpc.ts";
import type {
  HostedNetworkService,
  NetworkService,
  NetworkServiceFactory,
} from "./service.ts";

export interface Peer {
  readonly id: string;
  addresses(): readonly string[];
  services(): readonly string[];
  isConnected(): boolean;
  connect(): Promise<Peer>;
  refreshServices(): Promise<readonly string[]>;
  subscribe(listener: (event: "connected" | "disconnected") => void): () => void;
  service<Service extends NetworkService>(name: string): Service;
}

export interface ManagedPeer {
  readonly peer: Peer;
  addAddress(address: string): boolean;
  setServices(names: readonly string[]): boolean;
  host(name: string, factory: NetworkServiceFactory): HostedNetworkService;
  remove(name: string): void;
  hosted(name: string): HostedNetworkService | undefined;
  hostedServices(): readonly string[];
  trackEventFeed(name: string, close: () => void): () => void;
  connected(): void;
  close(reason: Error): void;
}

interface RemoteProjection {
  readonly remote: object;
  readonly events: RemoteEvents<unknown>;
  readonly data: ReturnType<typeof createRemoteData>;
}

export function createPeer(
  node: Libp2p,
  id: string,
  connect: (peer: ManagedPeer) => Promise<Peer>,
  refreshServices: (peer: ManagedPeer) => Promise<readonly string[]>,
): ManagedPeer {
  const addresses = new Set<string>();
  let services: readonly string[] = [];
  const listeners = new Set<(event: "connected" | "disconnected") => void>();
  const hosted = new Map<string, HostedNetworkService>();
  const eventFeeds = new Map<string, Set<() => void>>();
  const projections = new Map<string, RemoteProjection>();
  let managed: ManagedPeer;

  function isConnected(): boolean {
    return usableConnection(node, id) !== undefined;
  }

  function refreshAvailability(): void {
    const connected = isConnected();
    for (const [name, projection] of projections) {
      projection.events.available(connected && services.includes(name));
    }
  }

  function releaseService(name: string, reason: Error): void {
    const feeds = eventFeeds.get(name);
    eventFeeds.delete(name);
    for (const close of feeds ?? []) close();

    const data = hosted.get(name)?.data;
    if (data !== undefined) cancelData(data, reason);
    hosted.delete(name);
  }

  function projection(name: string): RemoteProjection {
    let existing = projections.get(name);
    if (existing === undefined) {
      const events = createRemoteEvents<unknown>(name, async (signal) =>
        await openBytes(name, eventsProtocol, signal)
      );
      existing = {
        events,
        remote: remoteService<object>(name, async (signal) => {
          requireAvailable(name);
          const connection = usableConnection(node, id);
          if (connection === undefined) throw new Error("This peer is not connected.");
          return await connection.newStream(rpcProtocol, { signal });
        }),
        data: createRemoteData(name, async () => await openBytes(name, dataProtocol)),
      };
      projections.set(name, existing);
      events.available(isConnected() && services.includes(name));
    }
    return existing;
  }

  const peer: Peer = {
    id,
    addresses: () => [...addresses],
    services: () => services,
    isConnected,
    async connect() {
      return await connect(managed);
    },
    async refreshServices() {
      return await refreshServices(managed);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    service<Service extends NetworkService>(name: string) {
      validateServiceName(name);
      const remote = projection(name);
      const local = hosted.get(name);
      // A hosted instance already owns the facets its peer reaches; only its methods
      // differ, because the host writes them and the peer awaits them.
      return Object.freeze(
        local === undefined
          ? { remote: remote.remote, events: remote.events.channel, data: remote.data }
          : { ...local, remote: remote.remote },
      ) as unknown as Service;
    },
  };

  managed = {
    peer,
    addAddress(address) {
      const normalized = addressWithPeerId(address, id);
      const changed = !addresses.has(normalized);
      addresses.add(normalized);
      return changed;
    },
    setServices(names) {
      if (
        services.length === names.length &&
        services.every((name, index) => name === names[index])
      ) return false;
      services = Object.freeze([...names]);
      refreshAvailability();
      return true;
    },
    host(name, factory) {
      validateServiceName(name);
      const existing = hosted.get(name);
      if (existing !== undefined) return existing;
      const service = factory(peer);
      hosted.set(name, service);
      return service;
    },
    remove(name) {
      releaseService(name, new Error(`The "${name}" service was removed.`));
    },
    hosted: (name) => hosted.get(name),
    hostedServices: () => [...hosted.keys()],
    trackEventFeed(name, close) {
      let feeds = eventFeeds.get(name);
      if (feeds === undefined) {
        feeds = new Set();
        eventFeeds.set(name, feeds);
      }
      feeds.add(close);
      return () => {
        feeds.delete(close);
        if (feeds.size === 0 && eventFeeds.get(name) === feeds) eventFeeds.delete(name);
      };
    },
    connected() {
      refreshAvailability();
      for (const listener of listeners) listener("connected");
    },
    close(reason) {
      for (const name of [...hosted.keys()]) releaseService(name, reason);
      refreshAvailability();
      for (const listener of listeners) listener("disconnected");
    },
  };

  return managed;

  function requireAvailable(name: string): void {
    if (!isConnected()) throw new Error("This peer is not connected.");
    if (!services.includes(name)) {
      throw new Error(`This peer does not provide the "${name}" service.`);
    }
  }

  async function openBytes(
    serviceName: string,
    protocol: string,
    signal?: AbortSignal,
  ): Promise<ByteStream> {
    requireAvailable(serviceName);
    const connection = usableConnection(node, id);
    if (connection === undefined) throw new Error("This peer is not connected.");
    return createByteStream(await connection.newStream(protocol, { signal }));
  }
}

export function usableConnection(node: Libp2p, id: string) {
  return node.getConnections().find((connection) =>
    connection.remotePeer.toString() === id && isUsableConnection(connection)
  );
}

export function isUsableConnection(
  connection: Awaited<ReturnType<Libp2p["dial"]>>,
): boolean {
  return connection.status === "open" && connection.direct && connection.limits === undefined;
}

export function destinationPeerId(address: string): string | undefined {
  const terminal = multiaddr(address).getComponents().at(-1);
  return terminal?.name === "p2p" ? terminal.value : undefined;
}

export function addressWithPeerId(address: string, id: string): string {
  const parsed = multiaddr(address);
  const addressedPeer = destinationPeerId(parsed.toString());
  if (addressedPeer !== undefined && addressedPeer !== id) {
    throw new Error("Peer addresses identify different peers.");
  }
  return addressedPeer === id
    ? parsed.toString()
    : parsed.encapsulate(`/p2p/${id}`).toString();
}

function validateServiceName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Every hosted peer service must have a name.");
  }
}
