import { describe, expect, it, vi } from "vitest";
import type { Network, Peer } from "../../common/network/index.ts";
import { createRoster } from "./roster.ts";

const firstId = "12D3KooWKnDdG3iXw9eTFijk3EWSunZcFi54Zka4wmtqtt6rPxc8";
const secondId = "QmYWYSUZ4PV6MRFYpdtEDJBiGs4UrmE6g8wmAWSePekXVW";
const localId = "12D3KooWQY1mzxK1TmJX9KhZBbPYANoLYv7SbjbR9diN7ykDFhFB";
const firstAddress = `/ip4/127.0.0.1/tcp/1001/ws/p2p/${firstId}`;
const firstAlternate = `/dns4/peer.example/tcp/1001/ws/p2p/${firstId}`;
const secondAddress = `/ip4/127.0.0.1/tcp/1002/ws/p2p/${secondId}`;
const localAddress = `/ip4/127.0.0.1/tcp/1003/ws/p2p/${localId}`;

function provider(
  id: string,
  services: () => Promise<readonly string[]>,
  addresses: () => Promise<readonly string[]>,
): Peer {
  return {
    id,
    isConnected: () => true,
    service: (name: string) => name === "registry"
      ? { list: services }
      : { list: addresses },
  } as unknown as Peer;
}

function testNetwork(connected: readonly Peer[], known: Map<string, Peer>) {
  let topologyListener: ((peer: Peer) => void) | undefined;
  const network = {
    id: localId,
    connectedPeers: vi.fn(() => connected),
    createPeer: vi.fn(async (address: string) => {
      let id = localId;
      if (address.endsWith(firstId)) id = firstId;
      if (address.endsWith(secondId)) id = secondId;
      const existing = known.get(id);
      if (existing !== undefined) return existing;
      const peer = {
        id,
        addresses: () => [address],
        isConnected: () => false,
        connect: vi.fn(),
      } as unknown as Peer;
      known.set(id, peer);
      return peer;
    }),
    subscribe(listener: (peer: Peer) => void) {
      topologyListener = listener;
      return () => {
        topologyListener = undefined;
      };
    },
  } as unknown as Network;

  return { network, topologyChanged: (peer: Peer) => topologyListener?.(peer) };
}

describe("Roster", () => {
  it("aggregates connected and discovered peers without connecting discoveries", async () => {
    const services = vi.fn(async () => ["registry", "discovery"]);
    const addresses = vi.fn(async () => [
      firstAddress,
      firstAlternate,
      secondAddress,
      localAddress,
      "/invalid",
    ]);
    const beacon = provider("beacon", services, addresses);
    const known = new Map<string, Peer>([[firstId, {
      id: firstId,
      isConnected: () => false,
    } as Peer]]);
    const { network } = testNetwork([beacon], known);
    const roster = createRoster(network);

    const first = await roster.list();
    const second = await roster.list();

    expect(first.map(({ id }) => id)).toEqual(["beacon", firstId, secondId]);
    expect(second.map(({ id }) => id)).toEqual(["beacon", firstId, secondId]);
    expect(services).toHaveBeenCalledTimes(2);
    expect(addresses).toHaveBeenCalledTimes(2);
    expect(network.createPeer).toHaveBeenCalledTimes(8);
    expect(network.createPeer).toHaveBeenCalledWith(firstAlternate);
    expect((known.get(secondId)?.connect as ReturnType<typeof vi.fn> | undefined))
      .not.toHaveBeenCalled();
  });

  it("skips providers without Discovery and tolerates failed or malformed providers", async () => {
    const plain = provider("plain", async () => ["registry"], async () => [firstAddress]);
    const failed = provider(
      "failed",
      async () => ["registry", "discovery"],
      async () => {
        throw new Error("Unavailable");
      },
    );
    const malformed = provider(
      "malformed",
      async () => {
        throw new Error("Peer returned invalid service names.");
      },
      async () => [secondAddress],
    );
    const { network } = testNetwork([plain, failed, malformed], new Map());

    await expect(createRoster(network).list()).resolves.toEqual([
      plain,
      failed,
      malformed,
    ]);
    expect(network.createPeer).not.toHaveBeenCalled();
  });

  it("gets connected peers without discovery and otherwise performs a fresh list", async () => {
    const connected = provider("connected", async () => ["registry"], async () => []);
    const discovered = { id: firstId, isConnected: () => false } as Peer;
    const known = new Map<string, Peer>([[firstId, discovered]]);
    const source = provider(
      "source",
      async () => ["registry", "discovery"],
      async () => [firstAddress],
    );
    const { network } = testNetwork([connected, source], known);
    const roster = createRoster(network);

    await expect(roster.getPeer("connected")).resolves.toBe(connected);
    expect(network.createPeer).not.toHaveBeenCalled();
    await expect(roster.getPeer(firstId)).resolves.toBe(discovered);
    expect(network.createPeer).toHaveBeenCalledOnce();
  });

  it("forwards Network topology notifications without retaining a list", () => {
    const remote = provider("remote", async () => ["registry"], async () => []);
    const { network, topologyChanged } = testNetwork([], new Map());
    const roster = createRoster(network);
    const listener = vi.fn();
    const unsubscribe = roster.subscribe(listener);

    topologyChanged(remote);
    unsubscribe();
    topologyChanged(remote);

    expect(listener).toHaveBeenCalledOnce();
  });
});
