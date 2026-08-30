import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ByteStream, Network, Peer, PeerEvent } from "@c/backend/network";
import type { DiscoveryUpdate } from "@c/backend/network/services/discovery";
import type { Session } from "@v/backend/session";
import { createSignals } from "@v/backend/signals";
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
      async () => ["registry", "identity"],
      undefined,
      async () => ({ name: "ada" }),
    );
    const beacon = provider(
      "beacon",
      async () => ["registry", "discovery"],
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
    });
    expect(Object.isFrozen(entries)).toBe(true);
    expect(entries.every(Object.isFrozen)).toBe(true);
    expect(context.network.createPeer).toHaveBeenCalledWith(secondAddress);
    expect(context.network.createPeer).toHaveBeenCalledWith(thirdAddress);
    expect(context.network.createPeer).not.toHaveBeenCalledWith(localAddress);
  });

  it("publishes keyed connection patches without rebuilding the list", async () => {
    const context = testContext(() => []);
    const roster = await createRoster(context.session);
    const updates = vi.fn();
    roster.updates.subscribe(updates);
    const remote = provider(firstId, async () => ["registry"]);

    context.peerChanged(remote, "connected");
    context.peerChanged(remote, "addresses");
    context.peerChanged(remote, "disconnected");

    expect(updates.mock.calls.map(([update]) => update.type)).toEqual([
      "set",
      "set",
      "remove",
    ]);
    expect(updates.mock.calls[0]?.[0].entry).toMatchObject({
      peerId: firstId,
      online: true,
    });
    expect(updates.mock.calls[2]?.[0]).toEqual({ type: "remove", peerId: firstId });
    expect(roster.list()).toEqual([]);
  });

  it("applies Discovery set and remove patches without reloading its snapshot", async () => {
    const stream = updateStream();
    const discovery = vi.fn(async () => []);
    const beacon = provider(
      "beacon",
      async () => ["registry", "discovery"],
      discovery,
      undefined,
      stream.stream,
    );
    const context = testContext(() => [beacon]);
    const roster = await createRoster(context.session);
    const updates = vi.fn();
    roster.updates.subscribe(updates);

    stream.publish({
      type: "set",
      peer: { peerId: firstId, addresses: [firstAddress, firstAlternate] },
    });
    await vi.waitFor(() => expect(roster.get(firstId)).toMatchObject({
      peerId: firstId,
      online: false,
    }));
    expect(discovery).toHaveBeenCalledOnce();
    expect(context.network.createPeer).toHaveBeenCalledWith(firstAddress, firstAlternate);
    expect(updates).toHaveBeenLastCalledWith(expect.objectContaining({ type: "set" }));

    stream.publish({ type: "remove", peerId: firstId });
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
      async () => ["registry", "identity"],
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
      async () => ["registry", "identity"],
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
      async () => ["registry", "identity"],
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
    }]);
    await nextStorage.close();
  });
});

function provider(
  id: string,
  services: () => Promise<unknown>,
  discovery: () => Promise<unknown> = async () => [],
  identity: () => Promise<unknown> = async () => ({ name: "peer" }),
  stream: ByteStream = idleStream(),
): Peer {
  return {
    id,
    addresses: () => [],
    isConnected: () => true,
    service: (name: string) => {
      if (name === "registry") return { list: services };
      if (name === "discovery") return { list: discovery };
      return { get: identity };
    },
    open: vi.fn(async () => stream),
  } as unknown as Peer;
}

function disconnectedPeer(id: string): Peer {
  return {
    id,
    addresses: () => [],
    isConnected: () => false,
    connect: vi.fn(),
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
  const listeners = new Set<(peer: Peer, event: PeerEvent) => void>();
  const identities = persistentValues(initialIdentities);
  const network = {
    id: localId,
    connectedPeers: vi.fn(initialPeers),
    createPeer: vi.fn(async (address: string) => {
      const id = [firstId, secondId, thirdId, localId]
        .find((candidate) => address.endsWith(candidate));
      if (id === undefined) throw new Error("Missing peer identity.");
      return disconnectedPeer(id);
    }),
    subscribe: vi.fn((listener: (peer: Peer, event: PeerEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  } as unknown as Network;
  const persistent = {
    peer: vi.fn(() => ({
      service: vi.fn(() => ({ kv: vi.fn(() => identities) })),
    })),
  } as unknown as PersistentStorage;
  const session = {
    network: vi.fn(async () => network),
    signals: createSignals,
    storage: (selection?: { readonly persistent?: boolean }) => {
      if (selection?.persistent === true) return persistent;
      throw new Error("Roster requested volatile Storage.");
    },
  } as unknown as Session;

  return {
    network,
    session,
    identities,
    peerChanged(peer: Peer, event: PeerEvent) {
      for (const listener of listeners) listener(peer, event);
    },
  };
}

function updateStream() {
  const chunks: Uint8Array[] = [];
  const readers: Array<() => void> = [];
  const stream: ByteStream = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (chunks.length === 0) {
          await new Promise<void>((resolve) => readers.push(resolve));
        }
        const chunk = chunks.shift();
        if (chunk !== undefined) yield chunk;
      }
    },
    async write() {},
    async close() {},
    abort() {},
  };
  return {
    stream,
    publish(update: DiscoveryUpdate) {
      chunks.push(new TextEncoder().encode(`${JSON.stringify(update)}\n`));
      readers.shift()?.();
    },
  };
}

function idleStream(): ByteStream {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise<void>(() => {});
    },
    async write() {},
    async close() {},
    abort() {},
  };
}

function networkWith(connected: () => readonly Peer[]): Network {
  return {
    id: localId,
    connectedPeers: connected,
    createPeer: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  } as unknown as Network;
}

async function persistentSession(
  network: Network,
  storage: PersistentRoot,
): Promise<Session> {
  return {
    network: async () => network,
    signals: createSignals,
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
