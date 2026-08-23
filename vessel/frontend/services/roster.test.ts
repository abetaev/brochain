import { describe, expect, it, vi } from "vitest";
import type {
  Network,
  Peer,
} from "@c/backend/network";
import type { Session } from "@v/backend/session";
import { createSignals } from "@v/backend/signals";
import { createRoster } from "./roster.ts";

const firstId = "12D3KooWKnDdG3iXw9eTFijk3EWSunZcFi54Zka4wmtqtt6rPxc8";
const secondId = "QmYWYSUZ4PV6MRFYpdtEDJBiGs4UrmE6g8wmAWSePekXVW";
const thirdId = "12D3KooWDnWcP4NdXrZ9iTiEhnH2AFqQiqJttS7xVZwZSCv8HXVa";
const localId = "12D3KooWQY1mzxK1TmJX9KhZBbPYANoLYv7SbjbR9diN7ykDFhFB";
const firstAddress = `/ip4/127.0.0.1/tcp/1001/ws/p2p/${firstId}`;
const firstAlternate = `/dns4/peer.example/tcp/1001/ws/p2p/${firstId}`;
const secondAddress = `/ip4/127.0.0.1/tcp/1002/ws/p2p/${secondId}`;
const secondAlternate = `/dns4/peer.example/tcp/1002/ws/p2p/${secondId}`;
const thirdAddress = `/ip4/127.0.0.1/tcp/1003/ws/p2p/${thirdId}`;
const localAddress = `/ip4/127.0.0.1/tcp/1004/ws/p2p/${localId}`;

function provider(
  id: string,
  services: () => Promise<unknown>,
  addresses: () => Promise<unknown>,
): Peer {
  return {
    id,
    isConnected: () => true,
    service: (name: string) => name === "registry"
      ? { list: services }
      : { list: addresses },
  } as unknown as Peer;
}

function disconnectedPeer(id: string): Peer {
  return {
    id,
    isConnected: () => false,
    connect: vi.fn(),
  } as unknown as Peer;
}

function testNetwork(connected: () => readonly Peer[]) {
  const created: Peer[] = [];
  const signals = createSignals();
  const topologyListeners = new Set<
    (peer: Peer, event: "connected" | "disconnected") => void
  >();
  const network = {
    id: localId,
    connectedPeers: vi.fn(connected),
    createPeer: vi.fn(async (address: string) => {
      const id = [firstId, secondId, thirdId, localId]
        .find((candidate) => address.endsWith(candidate));
      if (id === undefined) throw new Error("Missing peer identity.");
      const peer = disconnectedPeer(id);
      created.push(peer);
      return peer;
    }),
    subscribe: vi.fn((
      listener: (peer: Peer, event: "connected" | "disconnected") => void,
    ) => {
      topologyListeners.add(listener);
      return () => topologyListeners.delete(listener);
    }),
    close: vi.fn(),
  } as unknown as Network;
  const session = {
    network: vi.fn(async () => network),
    signals: vi.fn(() => signals),
  } as unknown as Session;
  return {
    network,
    session,
    created,
    topologyChanged(peer: Peer, event: "connected" | "disconnected") {
      for (const listener of [...topologyListeners]) listener(peer, event);
    },
  };
}

describe("Roster", () => {
  it("groups live Discovery results and creates each absent identity once", async () => {
    const first = provider(firstId, async () => ["registry"], async () => []);
    const beacon = provider(
      "beacon",
      async () => ["registry", "discovery"],
      async () => [
        firstAddress,
        secondAddress,
        firstAlternate,
        secondAddress,
        localAddress,
        "/invalid",
        "/ip4/127.0.0.1/tcp/1005/ws",
      ],
    );
    const other = provider(
      "other",
      async () => ["registry", "discovery"],
      async () => [firstAlternate, secondAlternate, thirdAddress],
    );
    const { network, session, created } = testNetwork(() => [beacon, first, other]);

    const roster = await createRoster(session);
    const peers = await roster.list();

    expect(peers.map(({ id }) => id)).toEqual([
      "beacon",
      firstId,
      "other",
      secondId,
      thirdId,
    ]);
    expect(network.connectedPeers).toHaveBeenCalledOnce();
    expect(network.createPeer).toHaveBeenCalledTimes(2);
    expect(network.createPeer).toHaveBeenCalledWith(secondAddress, secondAlternate);
    expect(network.createPeer).toHaveBeenCalledWith(thirdAddress);
    expect(network.createPeer).not.toHaveBeenCalledWith(localAddress);
    for (const peer of created) {
      expect(peer.connect).not.toHaveBeenCalled();
    }
  });

  it("passes every alternate for one identity in a single createPeer call", async () => {
    const relayWithoutDestination =
      `/ip4/127.0.0.1/tcp/1002/ws/p2p/${secondId}/p2p-circuit`;
    const source = provider(
      "source",
      async () => ["registry", "discovery"],
      async () => [
        firstAddress,
        firstAlternate,
        firstAddress,
        relayWithoutDestination,
      ],
    );
    const { network, session } = testNetwork(() => [source]);

    const roster = await createRoster(session);
    await roster.list();

    expect(network.createPeer).toHaveBeenCalledOnce();
    expect(network.createPeer).toHaveBeenCalledWith(firstAddress, firstAlternate);
  });

  it("validates capabilities and isolates failed or malformed providers", async () => {
    const noDiscoveryAddresses = vi.fn(async () => [firstAddress]);
    const noDiscovery = provider(
      "plain",
      async () => ["registry"],
      noDiscoveryAddresses,
    );
    const invalidRegistry = provider(
      "invalid-registry",
      async () => ["registry", "registry"],
      async () => [firstAddress],
    );
    const invalidDiscovery = provider(
      "invalid-discovery",
      async () => ["registry", "discovery"],
      async () => [secondAddress, 1],
    );
    const failed = provider(
      "failed",
      async () => ["registry", "discovery"],
      async () => {
        throw new Error("Unavailable.");
      },
    );
    const healthy = provider(
      "healthy",
      async () => ["registry", "discovery"],
      async () => [thirdAddress],
    );
    const connected = [
      noDiscovery,
      invalidRegistry,
      invalidDiscovery,
      failed,
      healthy,
    ];
    const { network, session } = testNetwork(() => connected);

    const roster = await createRoster(session);
    const peers = await roster.list();

    expect(peers.map(({ id }) => id)).toEqual([
      "plain",
      "invalid-registry",
      "invalid-discovery",
      "failed",
      "healthy",
      thirdId,
    ]);
    expect(noDiscoveryAddresses).not.toHaveBeenCalled();
    expect(network.createPeer).toHaveBeenCalledOnce();
    expect(network.createPeer).toHaveBeenCalledWith(thirdAddress);
  });

  it("keeps healthy identities when another createPeer call fails", async () => {
    const source = provider(
      "source",
      async () => ["registry", "discovery"],
      async () => [firstAddress, secondAddress],
    );
    const { network, session } = testNetwork(() => [source]);
    vi.mocked(network.createPeer).mockImplementation(async (address: string) => {
      if (address === firstAddress) throw new Error("Rejected address.");
      return disconnectedPeer(secondId);
    });

    const roster = await createRoster(session);
    await expect(roster.list()).resolves.toEqual([
      source,
      expect.objectContaining({ id: secondId }),
    ]);
  });

  it("is uncached and getPeer avoids discovery for a connected identity", async () => {
    const connected = provider("connected", async () => ["registry"], async () => []);
    const sourceServices = vi.fn(async () => ["registry", "discovery"]);
    const sourceDiscovery = vi.fn(async () => [firstAddress]);
    const source = provider("source", sourceServices, sourceDiscovery);
    const { network, session } = testNetwork(() => [connected, source]);
    const roster = await createRoster(session);

    await expect(roster.getPeer("connected")).resolves.toBe(connected);
    expect(sourceServices).not.toHaveBeenCalled();

    await expect(roster.getPeer(firstId)).resolves.toMatchObject({ id: firstId });
    await roster.list();

    expect(sourceServices).toHaveBeenCalledTimes(2);
    expect(sourceDiscovery).toHaveBeenCalledTimes(2);
    expect(network.createPeer).toHaveBeenCalledTimes(2);
    expect(session.network).toHaveBeenCalledOnce();
  });

  it("bridges topology changes through Session Signals for the Roster lifetime", async () => {
    const { network, session, topologyChanged } = testNetwork(() => []);
    const roster = await createRoster(session);
    const first = vi.fn();
    const second = vi.fn();
    const changedPeer = disconnectedPeer(firstId);

    expect(session.signals).toHaveBeenCalledOnce();
    expect(session.network).toHaveBeenCalledOnce();
    expect(network.subscribe).toHaveBeenCalledOnce();
    const stopFirst = roster.invalidations.subscribe(first);
    const stopSecond = roster.invalidations.subscribe(second);

    topologyChanged(changedPeer, "connected");
    topologyChanged(changedPeer, "disconnected");
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);

    stopFirst();
    topologyChanged(changedPeer, "connected");
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(3);

    stopSecond();
    topologyChanged(changedPeer, "disconnected");
    expect(second).toHaveBeenCalledTimes(3);
  });

  it("does not replay, retain, or refresh a list on invalidation", async () => {
    const services = vi.fn(async () => ["registry", "discovery"]);
    const addresses = vi.fn(async () => [firstAddress]);
    const source = provider("source", services, addresses);
    const { network, session, topologyChanged } = testNetwork(() => [source]);
    const roster = await createRoster(session);
    const invalidated = vi.fn();
    const changedPeer = disconnectedPeer(secondId);

    expect(network.subscribe).toHaveBeenCalledOnce();
    await roster.list();
    topologyChanged(changedPeer, "connected");
    const stop = roster.invalidations.subscribe(invalidated);
    expect(invalidated).not.toHaveBeenCalled();
    expect(services).toHaveBeenCalledOnce();
    expect(addresses).toHaveBeenCalledOnce();

    topologyChanged(changedPeer, "disconnected");
    expect(invalidated).toHaveBeenCalledOnce();
    expect(services).toHaveBeenCalledOnce();
    expect(addresses).toHaveBeenCalledOnce();

    await roster.list();

    expect(invalidated).toHaveBeenCalledOnce();
    expect(services).toHaveBeenCalledTimes(2);
    expect(addresses).toHaveBeenCalledTimes(2);
    expect(network.createPeer).toHaveBeenCalledTimes(2);
    stop();
  });
});
