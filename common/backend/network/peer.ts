import { multiaddr } from "@multiformats/multiaddr";
import type { Libp2p } from "libp2p";
import { createByteStream, type ByteStream } from "./byte-stream.ts";
import { remoteService, rpcProtocol, type PromisedMethods } from "./rpc.ts";

export interface Peer {
  readonly id: string;
  addresses(): readonly string[];
  isConnected(): boolean;
  connect(): Promise<Peer>;
  subscribe(listener: (event: "connected" | "disconnected") => void): () => void;
  service<Service extends object>(name: string): PromisedMethods<Service>;
  open(protocol: string, options?: { readonly signal?: AbortSignal }): Promise<ByteStream>;
}

export interface ManagedPeer {
  readonly peer: Peer;
  addAddress(address: string): string;
  connectionOpened(): void;
  connectionClosed(): void;
}

export function createPeer(
  node: Libp2p,
  id: string,
  requireOpen: () => void,
  connect: (peer: ManagedPeer) => Promise<Peer>,
): ManagedPeer {
  const addresses = new Set<string>();
  const listeners = new Set<(event: "connected" | "disconnected") => void>();
  let connected = false;
  let managed: ManagedPeer;

  function setConnected(next: boolean): void {
    if (next === connected) return;
    connected = next;
    const event = connected ? "connected" : "disconnected";
    for (const listener of listeners) listener(event);
  }

  const peer: Peer = {
    id,
    addresses: () => [...addresses],
    isConnected: () => connected,
    async connect() {
      requireOpen();
      return await connect(managed);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    service<Service extends object>(name: string) {
      validateServiceName(name);
      return remoteService<Service>(name, async (signal) => {
        requireOpen();
        if (!connected) throw new Error("This peer is not connected.");
        const connection = usableConnection(node, id);
        if (connection === undefined) throw new Error("This peer is not connected.");
        return await connection.newStream(rpcProtocol, { signal });
      });
    },
    async open(protocol, options) {
      validateProtocol(protocol);
      requireOpen();
      if (!connected) throw new Error("This peer is not connected.");
      const connection = usableConnection(node, id);
      if (connection === undefined) throw new Error("This peer is not connected.");
      return createByteStream(await connection.newStream(protocol, {
        signal: options?.signal,
      }));
    },
  };

  managed = {
    peer,
    addAddress(address) {
      const normalized = addressWithPeerId(address, id);
      addresses.add(normalized);
      return normalized;
    },
    connectionOpened() {
      setConnected(true);
    },
    connectionClosed() {
      setConnected(false);
    },
  };

  return managed;
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

function validateProtocol(protocol: string): void {
  if (typeof protocol !== "string" || protocol.length === 0) {
    throw new Error("Every byte-stream protocol must have an identifier.");
  }
}
