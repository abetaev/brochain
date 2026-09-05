import { multiaddr } from "@multiformats/multiaddr";
import type { Libp2p } from "libp2p";
import { createByteStream, type ByteStream } from "./byte-stream.ts";
import { createRemoteStream, dataProtocol, type Stream } from "./data.ts";
import { createRemoteEvents, eventsProtocol, type RemoteEvents } from "./events.ts";
import { remoteService, rpcProtocol } from "./rpc.ts";
import type { NetworkService, NetworkServiceFactory } from "./service.ts";

export interface Peer {
  readonly id: string;
  addresses(): readonly string[];
  services(): readonly string[];
  isConnected(): boolean;
  connect(): Promise<Peer>;
  disconnect(): Promise<void>;
  refreshServices(): Promise<readonly string[]>;
  hosts(name: string): boolean;
  service<Service extends object>(name: string): Service;
}

export interface ManagedPeer {
  readonly peer: Peer;
  addAddress(address: string): boolean;
  setServices(names: readonly string[]): boolean;
  host(name: string, factory: NetworkServiceFactory): NetworkService;
  remove(name: string): void;
  hosted(name: string): NetworkService | undefined;
  hostedServices(): readonly string[];
  trackEventFeed(name: string, close: () => void): () => void;
  retain(release: () => void): void;
  connected(): void;
  close(reason: Error): void;
}

export function createPeer(
  node: Libp2p,
  id: string,
  connect: (peer: ManagedPeer) => Promise<Peer>,
  disconnect: (peer: ManagedPeer) => Promise<void>,
  refreshServices: (peer: ManagedPeer) => Promise<readonly string[]>,
): ManagedPeer {
  const addresses = new Set<string>();
  let services: readonly string[] = [];
  const hosted = new Map<string, NetworkService>();
  const eventFeeds = new Map<string, Set<() => void>>();
  const remoteEvents = new Map<string, RemoteEvents<unknown>>();
  const remoteStreams = new Map<string, Stream>();
  const retained = new Set<() => void>();
  let managed: ManagedPeer;

  function isConnected(): boolean {
    return usableConnection(node, id) !== undefined;
  }

  function setFeedsAvailable(value: boolean): void {
    for (const events of remoteEvents.values()) events.available(value);
  }

  function releaseService(name: string, reason: Error): void {
    const feeds = eventFeeds.get(name);
    eventFeeds.delete(name);
    for (const close of feeds ?? []) close();

    hosted.get(name)?.data?.abort(reason);
    hosted.delete(name);
  }

  // Only the event feed carries state across calls; the other facets are opened per use.
  function feed(name: string): RemoteEvents<unknown> {
    let existing = remoteEvents.get(name);
    if (existing === undefined) {
      existing = createRemoteEvents<unknown>(name, async (signal) =>
        await openBytes(eventsProtocol, signal)
      );
      remoteEvents.set(name, existing);
      existing.available(isConnected());
    }
    return existing;
  }

  // Sending reaches the peer, so the outgoing stream is stable per service and its
  // transfer limit counts what this peer is actually sending.
  function outgoing(name: string): Stream {
    let existing = remoteStreams.get(name);
    if (existing === undefined) {
      existing = createRemoteStream(name, async () => await openBytes(dataProtocol));
      remoteStreams.set(name, existing);
    }
    return existing;
  }

  function callRemote(name: string) {
    return remoteService<object>(name, async (signal) =>
      await activeConnection().newStream(rpcProtocol, { signal })
    );
  }

  const peer: Peer = {
    id,
    addresses: () => [...addresses],
    services: () => services,
    isConnected,
    async connect() {
      return await connect(managed);
    },
    async disconnect() {
      await disconnect(managed);
    },
    async refreshServices() {
      return await refreshServices(managed);
    },
    hosts(name) {
      validateServiceName(name);
      return hosted.has(name);
    },
    service<Service extends object>(name: string) {
      validateServiceName(name);
      const local = hosted.get(name);
      // A hosted instance already owns the facets its peer reaches; only its methods
      // differ, because the host writes them and the peer awaits them.
      return Object.freeze(
        local === undefined
          ? { remote: callRemote(name), events: feed(name).channel, data: outgoing(name) }
          : {
            ...local,
            remote: callRemote(name),
            ...(local.data === undefined
              ? {}
              : { data: pairedStream(outgoing(name), local.data) }),
          },
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
      for (const events of remoteEvents.values()) events.retry();
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
    retain(release) {
      retained.add(release);
    },
    connected() {
      setFeedsAvailable(true);
    },
    close(reason) {
      for (const release of retained) release();
      retained.clear();
      for (const name of [...hosted.keys()]) releaseService(name, reason);
      setFeedsAvailable(false);
    },
  };

  return managed;

  // Whether the peer actually provides a service is the peer's answer to give, so
  // an interaction is attempted and its refusal reported rather than guessed here.
  function activeConnection() {
    const connection = usableConnection(node, id);
    if (connection === undefined) throw new Error("This peer is not connected.");
    return connection;
  }

  async function openBytes(protocol: string, signal?: AbortSignal): Promise<ByteStream> {
    return createByteStream(await activeConnection().newStream(protocol, { signal }));
  }
}

// A service sees one Stream for both directions: sending reaches the peer, while
// accepting takes what the peer sent to the instance hosted for it.
function pairedStream(outgoing: Stream, incoming: Stream): Stream {
  return Object.freeze({
    send: outgoing.send,
    accept: incoming.accept,
    abort: incoming.abort,
  });
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
