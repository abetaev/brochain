import { multiaddr } from "@multiformats/multiaddr";
import type { Libp2p } from "libp2p";
import {
  remoteService,
  rpcProtocol,
  type PeerService,
  type RemoteService,
} from "./rpc.ts";

export interface ServiceDefinition<
  Service extends PeerService = PeerService,
  Gateway = RemoteService<Service>,
> {
  readonly name: Service["name"];
  serve(peer: Peer): Service;
  gateway?(peer: Peer, remote: RemoteService<Service>): Gateway;
}

export type ServiceGateway<Definition extends ServiceDefinition> =
  Definition extends ServiceDefinition<infer _Service, infer Gateway> ? Gateway : never;

export interface Peer {
  readonly id: string;
  addresses(): readonly string[];
  isConnected(): boolean;
  connect(): Promise<void>;
  subscribe(listener: (event: "connected" | "disconnected") => void): () => void;
  service<Definition extends ServiceDefinition>(
    name: Definition["name"],
  ): ServiceGateway<Definition>;
}

export interface ManagedPeer {
  readonly peer: Peer;
  addAddress(address: string): string;
  connectionChanged(): void;
}

export function createPeer(
  node: Libp2p,
  id: string,
  lifetime: AbortSignal,
  requireOpen: () => void,
  definition: (name: string) => ServiceDefinition | undefined,
  topologyChanged: (peer: Peer) => void,
): ManagedPeer {
  const addresses = new Set<string>();
  const listeners = new Set<(event: "connected" | "disconnected") => void>();
  let connected = false;

  function connectionChanged(): void {
    const next = hasUsableConnection(node, id);
    if (next === connected) return;

    connected = next;
    const event = connected ? "connected" : "disconnected";
    for (const listener of listeners) listener(event);
    topologyChanged(peer);
  }

  const peer: Peer = {
    id,
    addresses: () => [...addresses],
    isConnected: () => connected,
    async connect() {
      requireOpen();
      connectionChanged();
      if (connected) return;
      if (addresses.size === 0) throw new Error("This peer has no known address.");

      const connection = await node.dial([...addresses].map(multiaddr), { signal: lifetime });
      if (connection.remotePeer.toString() !== id) {
        await connection.close();
        connectionChanged();
        throw new Error("The connected peer does not match its address.");
      }
      if (!isUsableConnection(connection)) {
        await connection.close();
        connectionChanged();
        throw new Error("A direct connection to this peer could not be established.");
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
    service<Definition extends ServiceDefinition>(name: Definition["name"]) {
      const remote = remoteService<PeerService>(name, async (signal) => {
        requireOpen();
        const connection = usableConnection(node, id);
        if (connection === undefined) throw new Error("This peer is not connected.");
        return await connection.newStream(rpcProtocol, { signal });
      });
      const localDefinition = definition(name);
      const gateway = localDefinition?.gateway;

      return (gateway === undefined ? remote : gateway(peer, remote)) as ServiceGateway<Definition>;
    },
  };

  return {
    peer,
    addAddress(address) {
      const normalized = multiaddr(address).toString();
      const addressedPeer = destinationPeerId(normalized);
      if (addressedPeer !== id) {
        throw new Error("A peer address must identify its peer.");
      }
      addresses.add(normalized);
      return normalized;
    },
    connectionChanged,
  };
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
  return multiaddr(address).getComponents()
    .filter(({ name }) => name === "p2p")
    .at(-1)?.value;
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

function hasUsableConnection(node: Libp2p, id: string): boolean {
  return usableConnection(node, id) !== undefined;
}
