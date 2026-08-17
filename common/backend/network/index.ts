import { multiaddr } from "@multiformats/multiaddr";
import type { Libp2p } from "libp2p";
import {
  createPeer as createManagedPeer,
  destinationPeerId,
  isUsableConnection,
  usableConnection,
  type ManagedPeer,
  type Peer,
} from "./peer.ts";
import { answerRpc, rpcProtocol } from "./rpc.ts";

export type { Peer } from "./peer.ts";
export type { PromisedMethods } from "./rpc.ts";

export interface Network {
  readonly id: string;
  createPeer(address: string, ...alternates: readonly string[]): Promise<Peer>;
  connectedPeers(): readonly Peer[];
  subscribe(
    listener: (peer: Peer, event: "connected" | "disconnected") => void,
  ): () => void;
  close(): Promise<void>;
}

export type InitializePeer = (peer: Peer, network: Network) => void;

interface PendingConnection {
  readonly candidate: ManagedPeer;
  readonly completion: Promise<Peer>;
}

export default async function createNetwork(
  node: Libp2p,
  initializePeer: InitializePeer = () => {},
): Promise<Network> {
  const localId = node.peerId.toString();
  const activePeers = new Map<string, ManagedPeer>();
  const pendingConnections = new Map<string, PendingConnection>();
  const pendingAuthentications = new Map<string, Promise<Peer>>();
  const topologyListeners = new Set<(
    peer: Peer,
    event: "connected" | "disconnected",
  ) => void>();
  const lifetime = new AbortController();
  let shutdown: Promise<void> | undefined;
  let closed = false;

  function requireOpen(): void {
    if (closed) throw new Error("This network is closed.");
  }

  function notifyTopology(
    peer: Peer,
    event: "connected" | "disconnected",
  ): void {
    for (const listener of topologyListeners) listener(peer, event);
  }

  function constructPeer(id: string): ManagedPeer {
    if (id === localId) throw new Error("The local peer cannot be created as a remote peer.");
    const managed = createManagedPeer(
      node,
      id,
      requireOpen,
      connectManagedPeer,
    );
    initializePeer(managed.peer, network);
    return managed;
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
    requireOpen();
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
    async createPeer(address, ...alternates) {
      requireOpen();
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
    subscribe(listener) {
      requireOpen();
      topologyListeners.add(listener);
      return () => topologyListeners.delete(listener);
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
      for (const [id, peer] of activePeers) {
        deactivatePeer(id, peer);
      }
      topologyListeners.clear();
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

  try {
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
        await answerRpc(stream, active.hostedService);
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

function addAddresses(peer: ManagedPeer, addresses: readonly string[]): void {
  for (const address of addresses) peer.addAddress(address);
}

function isDefined<Value>(value: Value | undefined): value is Value {
  return value !== undefined;
}
