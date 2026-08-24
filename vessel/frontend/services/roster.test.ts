import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Network, Peer } from "@c/backend/network";
import { createOptions, type OptionValue, type Options } from "@v/backend/options";
import type { Session } from "@v/backend/session";
import { createSignals, type Signals } from "@v/backend/signals";
import {
  createStorage,
  type PersistentKeyValueStorage,
  type PersistentStorage,
  type Storage,
} from "@v/backend/storage";
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
const databases = new Set<string>();

afterEach(async () => {
  await Promise.all([...databases].map(deleteDatabase));
  databases.clear();
});

function provider(
  id: string,
  serviceNames: () => Promise<unknown>,
  addresses: () => Promise<unknown> = async () => [],
  identity: () => Promise<unknown> = async () => ({ name: "peer" }),
): Peer {
  return {
    id,
    isConnected: () => true,
    service: (name: string) => {
      if (name === "registry") return { list: serviceNames };
      if (name === "discovery") return { list: addresses };
      return { get: identity };
    },
  } as unknown as Peer;
}

function disconnectedPeer(id: string): Peer {
  return {
    id,
    isConnected: () => false,
    connect: vi.fn(),
  } as unknown as Peer;
}

function persistentValues(
  initial: readonly (readonly [string, unknown])[] = [],
) {
  const values = new Map(initial);
  const get = vi.fn(async (key: string) => values.get(key));
  const put = vi.fn(async (key: string, value: unknown) => {
    values.set(key, value);
  });
  const remove = vi.fn(async (key: string) => {
    values.delete(key);
  });
  const entries = vi.fn(async () => [...values].sort(([first], [second]) =>
    first.localeCompare(second)
  ));
  return {
    values,
    get,
    put,
    delete: remove,
    entries,
  } as PersistentKeyValueStorage<unknown> & {
    readonly values: Map<string, unknown>;
    readonly get: typeof get;
    readonly put: typeof put;
    readonly delete: typeof remove;
    readonly entries: typeof entries;
  };
}

function testOptions(
  signals: Signals,
  initial: readonly (readonly [string, OptionValue])[] = [],
) {
  const values = new Map(initial);
  const changes = signals.channel<{
    readonly key: string;
    readonly value: OptionValue | undefined;
  }>({}, "options");
  const set = vi.fn(async (key: string, value: OptionValue) => {
    values.set(key, value);
    changes.publish({ key, value });
  });
  const unset = vi.fn(async (key: string) => {
    values.delete(key);
    changes.publish({ key, value: undefined });
  });
  const options: Options = {
    changes,
    get: (key) => values.get(key),
    set,
    unset,
  };
  return { options, values, set, unset };
}

function testContext(
  connected: () => readonly Peer[],
  initialIdentities: readonly (readonly [string, unknown])[] = [],
  initialOptions: readonly (readonly [string, OptionValue])[] = [],
) {
  const created: Peer[] = [];
  const signals = createSignals();
  const optionState = testOptions(signals, initialOptions);
  const identities = persistentValues(initialIdentities);
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
  } as unknown as Network;
  const kv = vi.fn(() => identities);
  const service = vi.fn(() => ({ kv }));
  const peerStorage = vi.fn(() => ({ service }));
  const persistent = { peer: peerStorage } as unknown as PersistentStorage;
  const storage = vi.fn((selection?: { readonly persistent?: boolean }) => {
    if (selection?.persistent === true) return persistent;
    throw new Error("Roster requested volatile Storage.");
  });
  const session = {
    network: vi.fn(async () => network),
    options: vi.fn(async () => optionState.options),
    signals: () => signals,
    storage,
  } as unknown as Session;

  return {
    network,
    session,
    created,
    identities,
    options: optionState,
    storage,
    peerStorage,
    service,
    kv,
    topologyChanged(peer: Peer, event: "connected" | "disconnected") {
      for (const listener of [...topologyListeners]) listener(peer, event);
    },
  };
}

describe("persistent unified Roster", () => {
  it("combines connected, discovered, and cached-only entries in stable order", async () => {
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
        secondAddress,
        thirdAddress,
        secondAlternate,
        localAddress,
      ],
    );
    const context = testContext(
      () => [first, beacon],
      [["peers/cached.identity", { name: "cy" }]],
      [[`peers/${firstId}.display_name`, "friend"]],
    );

    const roster = await createRoster(context.session);
    const entries = await roster.list();

    expect(entries.map(({ peerId }) => peerId)).toEqual([
      firstId,
      "beacon",
      secondId,
      thirdId,
      "cached",
    ]);
    expect(entries[0]).toEqual({
      peerId: firstId,
      peer: first,
      online: true,
      identity: { name: "ada" },
      name: "friend",
    });
    expect(entries[2]).toMatchObject({
      peerId: secondId,
      online: false,
      name: secondId,
    });
    expect(entries[2]?.peer).toBeDefined();
    expect(entries[4]).toEqual({
      peerId: "cached",
      online: false,
      identity: { name: "cy" },
      name: "cy",
    });
    expect(Object.isFrozen(entries)).toBe(true);
    expect(entries.every(Object.isFrozen)).toBe(true);
    expect(context.network.createPeer).toHaveBeenCalledWith(
      secondAddress,
      secondAlternate,
    );
    expect(context.network.createPeer).toHaveBeenCalledWith(thirdAddress);
    expect(context.network.createPeer).not.toHaveBeenCalledWith(localAddress);
    for (const peer of context.created) expect(peer.connect).not.toHaveBeenCalled();
  });

  it("uses the local peer Roster scope and removes invalid persisted observations", async () => {
    const context = testContext(() => [], [
      ["invalid", { name: "ada" }],
      [`peers/${localId}.identity`, { name: "local" }],
      ["peers/bad.identity", { name: "Not valid" }],
      ["peers/good.identity", { name: "bea", extra: true }],
    ]);

    const roster = await createRoster(context.session);

    expect(context.storage).toHaveBeenCalledWith({ persistent: true });
    expect(context.peerStorage).toHaveBeenCalledWith(localId);
    expect(context.service).toHaveBeenCalledWith("roster");
    expect(context.kv).toHaveBeenCalledWith();
    expect(context.identities.delete.mock.calls).toEqual([
      ["invalid"],
      [`peers/${localId}.identity`],
      ["peers/bad.identity"],
    ]);
    await expect(roster.list()).resolves.toEqual([{
      peerId: "good",
      online: false,
      identity: { name: "bea" },
      name: "bea",
    }]);
    expect(context.options.values.get("peers/good.display_name")).toBe("bea");
  });

  it("rejects construction when invalid-record cleanup fails", async () => {
    const context = testContext(() => [], [["invalid", { name: "ada" }]]);
    const failure = new Error("Cleanup failed.");
    context.identities.delete.mockRejectedValueOnce(failure);

    await expect(createRoster(context.session)).rejects.toBe(failure);
  });

  it("persists Identity before initializing a name and never overwrites that name", async () => {
    let remoteName = "ada";
    const remote = provider(
      firstId,
      async () => ["registry", "identity"],
      undefined,
      async () => ({ name: remoteName }),
    );
    const context = testContext(() => [remote]);
    const roster = await createRoster(context.session);
    const invalidated = vi.fn();
    roster.invalidations.subscribe(invalidated);

    await expect(roster.list()).resolves.toEqual([{
      peerId: firstId,
      peer: remote,
      online: true,
      identity: { name: "ada" },
      name: "ada",
    }]);
    expect(context.identities.put).toHaveBeenCalledWith(
      `peers/${firstId}.identity`,
      { name: "ada" },
    );
    expect(context.identities.put.mock.invocationCallOrder[0])
      .toBeLessThan(context.options.set.mock.invocationCallOrder[0]!);
    expect(context.options.set).toHaveBeenCalledWith(
      `peers/${firstId}.display_name`,
      "ada",
    );
    expect(invalidated).not.toHaveBeenCalled();

    await context.options.options.set(`peers/${firstId}.display_name`, "friend");
    expect(invalidated).toHaveBeenCalledOnce();
    remoteName = "bea";
    const [entry] = await roster.list();

    expect(entry?.identity).toEqual({ name: "bea" });
    expect(entry?.name).toBe("friend");
    expect(context.options.values.get(`peers/${firstId}.display_name`)).toBe("friend");
  });

  it("ignores a non-string display Option without overwriting it", async () => {
    const remote = provider(
      firstId,
      async () => ["registry", "identity"],
      undefined,
      async () => ({ name: "ada" }),
    );
    const key = `peers/${firstId}.display_name`;
    const context = testContext(() => [remote], [], [[key, null]]);
    const roster = await createRoster(context.session);

    const [entry] = await roster.list();

    expect(entry?.name).toBe("ada");
    expect(context.options.values.get(key)).toBeNull();
    expect(context.options.set).not.toHaveBeenCalled();
  });

  it("retains a cached Identity after remote failure or invalid data", async () => {
    let value: unknown = { name: "Not valid" };
    let unavailable = false;
    const remote = provider(
      firstId,
      async () => ["registry", "identity"],
      undefined,
      async () => {
        if (unavailable) throw new Error("Unavailable.");
        return value;
      },
    );
    const key = `peers/${firstId}.identity`;
    const context = testContext(
      () => [remote],
      [[key, { name: "ada" }]],
      [[`peers/${firstId}.display_name`, "ada"]],
    );
    const roster = await createRoster(context.session);

    expect((await roster.list())[0]?.identity).toEqual({ name: "ada" });
    unavailable = true;
    expect((await roster.list())[0]?.identity).toEqual({ name: "ada" });
    expect(context.identities.put).not.toHaveBeenCalled();
  });

  it("surfaces Identity persistence failure without replacing the cached projection", async () => {
    let value: unknown = { name: "bea" };
    const remote = provider(
      firstId,
      async () => ["registry", "identity"],
      undefined,
      async () => value,
    );
    const key = `peers/${firstId}.identity`;
    const context = testContext(
      () => [remote],
      [[key, { name: "ada" }]],
      [[`peers/${firstId}.display_name`, "ada"]],
    );
    const failure = new Error("Persistence failed.");
    context.identities.put.mockRejectedValueOnce(failure);
    const roster = await createRoster(context.session);

    await expect(roster.list()).rejects.toBe(failure);
    expect(context.identities.values.get(key)).toEqual({ name: "ada" });

    value = { name: "Not valid" };
    expect((await roster.list())[0]?.identity).toEqual({ name: "ada" });
  });

  it("keeps a persisted Identity when first-name initialization fails and retries it", async () => {
    const remote = provider(
      firstId,
      async () => ["registry", "identity"],
      undefined,
      async () => ({ name: "ada" }),
    );
    const context = testContext(() => [remote]);
    const failure = new Error("Option persistence failed.");
    context.options.set.mockRejectedValueOnce(failure);
    const roster = await createRoster(context.session);
    const identityKey = `peers/${firstId}.identity`;
    const displayKey = `peers/${firstId}.display_name`;

    await expect(roster.list()).rejects.toBe(failure);
    expect(context.identities.values.get(identityKey)).toEqual({ name: "ada" });
    expect(context.options.values.has(displayKey)).toBe(false);

    const [entry] = await roster.list();
    expect(entry?.identity).toEqual({ name: "ada" });
    expect(entry?.name).toBe("ada");
    expect(context.identities.put).toHaveBeenCalledOnce();
    expect(context.options.values.get(displayKey)).toBe("ada");
  });
});

describe("Roster discovery and invalidation", () => {
  it("groups alternate addresses and isolates malformed or failed providers", async () => {
    const noDiscoveryAddresses = vi.fn(async () => [firstAddress]);
    const noDiscovery = provider("plain", async () => ["registry"], noDiscoveryAddresses);
    const invalidRegistry = provider(
      "invalid-registry",
      async () => ["registry", "registry"],
      async () => [firstAddress],
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
      async () => [firstAddress, firstAlternate, firstAddress],
    );
    const context = testContext(() => [noDiscovery, invalidRegistry, failed, healthy]);
    const roster = await createRoster(context.session);

    const entries = await roster.list();

    expect(entries.map(({ peerId }) => peerId)).toEqual([
      "plain",
      "invalid-registry",
      "failed",
      "healthy",
      firstId,
    ]);
    expect(noDiscoveryAddresses).not.toHaveBeenCalled();
    expect(context.network.createPeer).toHaveBeenCalledOnce();
    expect(context.network.createPeer).toHaveBeenCalledWith(firstAddress, firstAlternate);
  });

  it("keeps healthy discoveries when another Peer creation fails", async () => {
    const source = provider(
      "source",
      async () => ["registry", "discovery"],
      async () => [firstAddress, secondAddress],
    );
    const context = testContext(() => [source]);
    vi.mocked(context.network.createPeer).mockImplementation(async (address: string) => {
      if (address === firstAddress) throw new Error("Rejected address.");
      return disconnectedPeer(secondId);
    });
    const roster = await createRoster(context.session);

    await expect(roster.list()).resolves.toEqual([
      expect.objectContaining({ peerId: "source", online: true }),
      expect.objectContaining({ peerId: secondId, online: false }),
    ]);
  });

  it("gets a connected entry without scanning other Discovery providers", async () => {
    const connected = provider("connected", async () => ["registry"]);
    const sourceServices = vi.fn(async () => ["registry", "discovery"]);
    const sourceDiscovery = vi.fn(async () => [firstAddress]);
    const source = provider("source", sourceServices, sourceDiscovery);
    const context = testContext(() => [connected, source]);
    const roster = await createRoster(context.session);

    await expect(roster.get("connected")).resolves.toEqual({
      peerId: "connected",
      peer: connected,
      online: true,
      name: "connected",
    });
    expect(sourceServices).not.toHaveBeenCalled();

    await expect(roster.get(firstId)).resolves.toMatchObject({
      peerId: firstId,
      online: false,
    });
    expect(sourceServices).toHaveBeenCalledOnce();
    expect(sourceDiscovery).toHaveBeenCalledOnce();
  });

  it("bridges topology and external display-name changes without replay", async () => {
    const context = testContext(() => []);
    const roster = await createRoster(context.session);
    const listener = vi.fn();
    const changedPeer = disconnectedPeer(firstId);

    expect(context.network.subscribe).toHaveBeenCalledOnce();
    const stop = roster.invalidations.subscribe(listener);
    expect(listener).not.toHaveBeenCalled();

    context.topologyChanged(changedPeer, "connected");
    await context.options.options.set(`peers/${firstId}.display_name`, "friend");
    await context.options.options.set("unrelated", true);
    await context.options.options.set(`peers/${localId}.display_name`, "local");
    expect(listener).toHaveBeenCalledTimes(2);

    stop();
    context.topologyChanged(changedPeer, "disconnected");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("Roster persistence", () => {
  it("recovers cached-only peers through a fresh Storage and Roster lifetime", async () => {
    const application = `brochain-roster-test-${crypto.randomUUID()}`;
    const databaseName = `${application}/alice`;
    databases.add(databaseName);
    const remote = provider(
      firstId,
      async () => ["registry", "identity"],
      undefined,
      async () => ({ name: "ada" }),
    );
    const firstStorage = createStorage("alice", application);
    const firstNetwork = networkWith(() => [remote]);
    const firstSession = await persistentSession(firstNetwork, firstStorage);
    const firstRoster = await createRoster(firstSession);

    expect((await firstRoster.list())[0]?.identity).toEqual({ name: "ada" });
    await firstStorage.close();

    const nextStorage = createStorage("alice", application);
    const nextSession = await persistentSession(networkWith(() => []), nextStorage);
    const nextRoster = await createRoster(nextSession);

    await expect(nextRoster.list()).resolves.toEqual([{
      peerId: firstId,
      online: false,
      identity: { name: "ada" },
      name: "ada",
    }]);
    await nextStorage.close();
  });
});

function networkWith(connected: () => readonly Peer[]): Network {
  return {
    id: localId,
    connectedPeers: connected,
    createPeer: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  } as unknown as Network;
}

async function persistentSession(network: Network, storage: Storage): Promise<Session> {
  const signals = createSignals();
  const options = await createOptions(
    storage.persistent.peer(network.id).service("options"),
    signals,
  );
  const accessStorage = (selection?: { readonly persistent?: boolean }) =>
    selection?.persistent === true ? storage.persistent : storage;
  return {
    network: async () => network,
    options: async () => options,
    signals: () => signals,
    storage: accessStorage,
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
