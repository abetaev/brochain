import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Peer } from "@c/backend/network";
import type { DiscoveryUpdate } from "@c/backend/network/services/discovery";
import type { Network, NetworkUpdate } from "@v/backend/network";
import type { Session } from "@v/backend/session";
import signals from "@c/backend/signals";
import type {
  PersistentKeyValueStorage,
  PersistentStorage,
} from "@v/backend/storage";
import {
  createPersistentRoot,
  type PersistentRoot,
} from "@v/backend/storage/persistent";
import { createRoster } from "./roster.ts";

const firstId = "12D3KooWKnDdG3iXw9eTFijk3EWSunZcFi54Zka4wmtqtt6rPxc8";
const secondId = "QmYWYSUZ4PV6MRFYpdtEDJBiGs4UrmE6g8wmAWSePekXVW";
const thirdId = "12D3KooWDnWcP4NdXrZ9iTiEhnH2AFqQiqJttS7xVZwZSCv8HXVa";
const localId = "12D3KooWQY1mzxK1TmJX9KhZBbPYANoLYv7SbjbR9diN7ykDFhFB";
const firstAddress = `/ip4/127.0.0.1/tcp/1001/ws/p2p/${firstId}`;
const firstAlternate = `/dns4/peer.example/tcp/1001/ws/p2p/${firstId}`;
const secondAddress = `/ip4/127.0.0.1/tcp/1002/ws/p2p/${secondId}`;
const thirdAddress = `/ip4/127.0.0.1/tcp/1003/ws/p2p/${thirdId}`;
const localAddress = `/ip4/127.0.0.1/tcp/1004/ws/p2p/${localId}`;
const databases = new Set<string>();

afterEach(async () => {
  await Promise.all([...databases].map(deleteDatabase));
  databases.clear();
});

describe("Roster state", () => {
  it("initializes connected, discovered, and cached peers once", async () => {
    const first = provider(
      firstId,
      () => ["registry", "identity"],
      undefined,
      async () => ({ name: "ada" }),
    );
    const beacon = provider(
      "beacon",
      () => ["registry", "discovery"],
      async () => [
        { peerId: secondId, addresses: [secondAddress, firstAlternate, secondAddress] },
        { peerId: thirdId, addresses: [thirdAddress] },
        { peerId: localId, addresses: [localAddress] },
      ],
    );
    const context = testContext(
      () => [first, beacon],
      [["peers/cached.identity", { name: "cy" }]],
    );

    const roster = await createRoster(context.session);
    const entries = roster.list();

    expect(entries.map(({ peerId }) => peerId)).toEqual([
      firstId,
      "beacon",
      secondId,
      thirdId,
      "cached",
    ]);
    expect(roster.get(firstId)).toEqual({
      peerId: firstId,
      peer: first,
      online: true,
      identity: { name: "ada" },
      name: "ada",
      addresses: [],
    });
    expect(roster.get(secondId)).toMatchObject({
      peerId: secondId,
      online: false,
      name: secondId,
    });
    expect(roster.get("cached")).toEqual({
      peerId: "cached",
      online: false,
      identity: { name: "cy" },
      name: "cy",
      addresses: [],
    });
    expect(Object.isFrozen(entries)).toBe(true);
    expect(entries.every(Object.isFrozen)).toBe(true);
    expect(roster.get(secondId)?.addresses).toEqual([secondAddress]);
    expect(roster.get(thirdId)?.addresses).toEqual([thirdAddress]);
    expect(roster.get(localId)).toBeUndefined();
  });

  it("publishes keyed connection patches without rebuilding the list", async () => {
    const context = testContext(() => []);
    const roster = await createRoster(context.session);
    const updates = vi.fn();
    roster.updates.subscribe(updates);
    const remote = provider(firstId, () => ["registry"]);

    context.peerChanged(remote, "connected");
    context.peerChanged(remote, "addresses");
    context.peerChanged(remote, "services");
    context.peerChanged(remote, "disconnected");

    expect(updates.mock.calls.map(([update]) => update.type)).toEqual([
      "set",
      "set",
      "set",
      "remove",
    ]);
    expect(updates.mock.calls[0]?.[0].entry).toMatchObject({
      peerId: firstId,
      online: true,
    });
    expect(updates.mock.calls[3]?.[0]).toEqual({ type: "remove", peerId: firstId });
    expect(roster.list()).toEqual([]);
  });

  it("applies Discovery set and remove patches without reloading its snapshot", async () => {
    const discoveryUpdates = signals.channel<DiscoveryUpdate>();
    const discovery = vi.fn(async () => []);
    const beacon = provider(
      "beacon",
      () => ["registry", "discovery"],
      discovery,
      undefined,
      discoveryUpdates,
    );
    const context = testContext(() => [beacon]);
    const roster = await createRoster(context.session);
    const updates = vi.fn();
    roster.updates.subscribe(updates);

    discoveryUpdates.publish({
      type: "set",
      peer: { peerId: firstId, addresses: [firstAddress, firstAlternate] },
    });
    await vi.waitFor(() => expect(roster.get(firstId)).toMatchObject({
      peerId: firstId,
      online: false,
    }));
    expect(discovery).toHaveBeenCalledOnce();
    expect(roster.get(firstId)?.addresses).toEqual([firstAddress, firstAlternate]);
    expect(updates).toHaveBeenLastCalledWith(expect.objectContaining({ type: "set" }));

    discoveryUpdates.publish({ type: "remove", peerId: firstId });
    await vi.waitFor(() => expect(roster.get(firstId)).toBeUndefined());
    expect(updates).toHaveBeenLastCalledWith({ type: "remove", peerId: firstId });
    expect(discovery).toHaveBeenCalledOnce();

    await roster.refresh();
    expect(discovery).toHaveBeenCalledTimes(2);
  });

  it("publishes a changed Identity after it is persisted", async () => {
    let name = "ada";
    const remote = provider(
      firstId,
      () => ["registry", "identity"],
      undefined,
      async () => ({ name }),
    );
    const context = testContext(() => [remote]);
    const roster = await createRoster(context.session);
    const updates = vi.fn();
    roster.updates.subscribe(updates);

    name = "bea";
    await roster.refresh();

    expect(context.identities.put).toHaveBeenLastCalledWith(
      `peers/${firstId}.identity`,
      { name: "bea" },
    );
    expect(updates).toHaveBeenCalledOnce();
    expect(updates).toHaveBeenCalledWith({
      type: "set",
      entry: expect.objectContaining({ peerId: firstId, name: "bea" }),
    });

    await roster.refresh();
    expect(updates).toHaveBeenCalledOnce();
  });

  it("keeps the fallback entry when remote data is unavailable", async () => {
    const failed = provider(
      firstId,
      () => ["registry", "identity"],
      undefined,
      async () => {
        throw new Error("Unavailable.");
      },
    );
    const context = testContext(
      () => [failed],
      [[`peers/${firstId}.identity`, { name: "ada" }]],
    );

    const roster = await createRoster(context.session);

    expect(roster.get(firstId)).toEqual({
      peerId: firstId,
      peer: failed,
      online: true,
      identity: { name: "ada" },
      name: "ada",
      addresses: [],
    });
  });

  it("removes invalid persisted observations during construction", async () => {
    const context = testContext(() => [], [
      ["invalid", { name: "ada" }],
      [`peers/${localId}.identity`, { name: "local" }],
      ["peers/bad.identity", { name: "Not valid" }],
      ["peers/good.identity", { name: "bea", extra: true }],
    ]);

    const roster = await createRoster(context.session);

    expect(context.identities.delete.mock.calls).toEqual([
      ["invalid"],
      [`peers/${localId}.identity`],
      ["peers/bad.identity"],
    ]);
    expect(roster.list()).toEqual([{
      peerId: "good",
      online: false,
      identity: { name: "bea" },
      name: "bea",
      addresses: [],
    }]);
  });

  it("rejects construction when invalid-record cleanup fails", async () => {
    const context = testContext(() => [], [["invalid", { name: "ada" }]]);
    const failure = new Error("Cleanup failed.");
    context.identities.delete.mockRejectedValueOnce(failure);

    await expect(createRoster(context.session)).rejects.toBe(failure);
  });
});

describe("Roster persistence", () => {
  it("recovers a cached Identity in a fresh lifetime", async () => {
    const application = `brochain-roster-test-${crypto.randomUUID()}`;
    const databaseName = `${application}/alice`;
    databases.add(databaseName);
    const remote = provider(
      firstId,
      () => ["registry", "identity"],
      undefined,
      async () => ({ name: "ada" }),
    );
    const firstStorage = await createPersistentRoot(`${application}/alice`);
    const firstRoster = await createRoster(
      await persistentSession(networkWith(() => [remote]), firstStorage),
    );

    expect(firstRoster.get(firstId)?.identity).toEqual({ name: "ada" });
    await firstStorage.close();

    const nextStorage = await createPersistentRoot(`${application}/alice`);
    const nextRoster = await createRoster(
      await persistentSession(networkWith(() => []), nextStorage),
    );

    expect(nextRoster.list()).toEqual([{
      peerId: firstId,
      online: false,
      identity: { name: "ada" },
      name: "ada",
      addresses: [],
    }]);
    await nextStorage.close();
  });
});

function provider(
  id: string,
  services: () => readonly string[],
  discovery: () => Promise<unknown> = async () => [],
  identity: () => Promise<unknown> = async () => ({ name: "peer" }),
  discoveryUpdates = signals.channel<DiscoveryUpdate>(),
): Peer {
  return {
    id,
    addresses: () => [],
    services,
    isConnected: () => true,
    refreshServices: async () => services(),
    hosts: () => false,
    service: (name: string) => {
      if (name === "registry") return { remote: { list: services } };
      if (name === "discovery") {
        return { remote: { list: discovery }, events: discoveryUpdates };
      }
      return { remote: { get: identity } };
    },
  } as unknown as Peer;
}

function persistentValues(
  initial: readonly (readonly [string, unknown])[] = [],
) {
  const values = new Map(initial);
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key);
    }),
    entries: vi.fn(async () => [...values]),
  } as PersistentKeyValueStorage<unknown> & {
    readonly values: Map<string, unknown>;
    readonly put: ReturnType<typeof vi.fn>;
    readonly delete: ReturnType<typeof vi.fn>;
  };
}

function testContext(
  initialPeers: () => readonly Peer[],
  initialIdentities: readonly (readonly [string, unknown])[] = [],
) {
  const identities = persistentValues(initialIdentities);
  const updates = signals.channel<NetworkUpdate>();
  const network = {
    id: localId,
    connectedPeers: vi.fn(initialPeers),
    updates,
  } as unknown as Network;
  const persistent = {
    service: vi.fn(() => ({ kv: vi.fn(() => identities) })),
  } as unknown as PersistentStorage;
  const session = {
    network: vi.fn(() => network),
    storage: (selection?: { readonly persistent?: boolean }) => {
      if (selection?.persistent === true) return persistent;
      throw new Error("Roster requested volatile Storage.");
    },
  } as unknown as Session;

  return {
    network,
    session,
    identities,
    peerChanged(peer: Peer, type: "connected" | "disconnected" | "addresses" | "services") {
      updates.publish(type === "disconnected"
        ? { type, peerId: peer.id }
        : { type, peer });
    },
  };
}

function networkWith(connected: () => readonly Peer[]): Network {
  return {
    id: localId,
    connectedPeers: connected,
    updates: signals.channel(),
  } as unknown as Network;
}

async function persistentSession(
  network: Network,
  storage: PersistentRoot,
): Promise<Session> {
  return {
    network: () => network,
    storage: () => storage,
  } as unknown as Session;
}

async function deleteDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Test database deletion was blocked."));
  });
}
