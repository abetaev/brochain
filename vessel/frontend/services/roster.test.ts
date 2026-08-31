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
import { createRoster } from "./roster.ts";

const firstId = "12D3KooWKnDdG3iXw9eTFijk3EWSunZcFi54Zka4wmtqtt6rPxc8";
const localId = "12D3KooWQY1mzxK1TmJX9KhZBbPYANoLYv7SbjbR9diN7ykDFhFB";
const databases = new Set<string>();

afterEach(async () => {
  await Promise.all([...databases].map(deleteDatabase));
  databases.clear();
});

describe("Roster state", () => {




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

async function deleteDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Test database deletion was blocked."));
  });
}
