import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Peer } from "@c/backend/network";
import type { DiscoveryUpdate } from "@c/backend/network/services/discovery";
import type { Network, NetworkUpdate } from "@v/backend/network";
import { setDisplayName } from "@v/backend/options/peer-names";
import type { Options } from "@v/backend/options";
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
  it("names a peer from its reported identity and keeps a chosen name", async () => {
    const context = testContext(() => [provider(firstId, () => ["registry", "identity"])]);

    const roster = await createRoster(context.session);
    await vi.waitFor(() => expect(context.names.values.get(firstId)).toBe("peer"));
    expect(roster.get(firstId)?.name).toBe("peer");

    await setDisplayName(context.session.options(), firstId, "  chosen  ");
    expect(roster.get(firstId)?.name).toBe("chosen");

    // A later identification must not take a chosen name back.
    await roster.refresh();
    expect(roster.get(firstId)?.name).toBe("chosen");
    expect(roster.get(firstId)?.identity).toEqual({ name: "peer" });

    await roster.resetDisplayName(firstId);
    expect(roster.get(firstId)?.name).toBe("peer");
  });

  it("names by the peer ID once a reported name is forgotten", async () => {
    const context = testContext(
      () => [provider(firstId, () => ["registry"])],
      [[`peers/${firstId}.identity`, { name: "ada" }]],
    );

    const roster = await createRoster(context.session);
    await vi.waitFor(() => expect(roster.get(firstId)?.name).toBe("ada"));

    // Resetting alone returns to what the peer last reported.
    await roster.resetDisplayName(firstId);
    expect(roster.get(firstId)?.name).toBe("ada");

    await roster.clearIdentity(firstId);
    await roster.resetDisplayName(firstId);

    expect(roster.get(firstId)?.identity).toBeUndefined();
    expect(roster.get(firstId)?.name).toBe(firstId);
    await expect(roster.refreshIdentity(firstId)).rejects.toThrow("does not report a name");
  });

  it("names an unidentified peer by its peer ID", async () => {
    const context = testContext(() => [provider(firstId, () => ["registry"])]);

    const roster = await createRoster(context.session);

    expect(context.names.values.has(firstId)).toBe(false);
    expect(roster.get(firstId)?.name).toBe(firstId);
  });

  it("refuses a name outside one to sixty-four characters", async () => {
    const context = testContext(() => []);
    await createRoster(context.session);
    const options = context.session.options();

    await expect(setDisplayName(options, firstId, "   ")).rejects.toThrow("1 to 64");
    await expect(setDisplayName(options, firstId, "n".repeat(65))).rejects.toThrow("1 to 64");
    await expect(setDisplayName(options, firstId, "n".repeat(64))).resolves.toBeUndefined();
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

// Only the peer object scope Roster reaches is modelled.
function optionValues() {
  const values = new Map<string, string>();
  const listeners = new Map<string, Set<(value: string | undefined) => unknown>>();

  function publish(peerId: string): void {
    for (const listener of listeners.get(peerId) ?? []) listener(values.get(peerId));
  }

  return {
    values,
    options: {
      cat: () => ({
        obj: (peerId: string) => ({
          get: () => values.get(peerId),
          set: async (_name: string, value: string) => {
            values.set(peerId, value);
            publish(peerId);
          },
          unset: async () => {
            values.delete(peerId);
            publish(peerId);
          },
          observe: (_name: string, listener: (value: string | undefined) => unknown) => {
            let observers = listeners.get(peerId);
            if (observers === undefined) {
              observers = new Set();
              listeners.set(peerId, observers);
            }
            observers.add(listener);
            return () => observers?.delete(listener);
          },
        }),
      }),
    } as unknown as Options,
  };
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
  const names = optionValues();
  const session = {
    network: vi.fn(() => network),
    options: () => names.options,
    storage: (selection?: { readonly persistent?: boolean }) => {
      if (selection?.persistent === true) return persistent;
      throw new Error("Roster requested volatile Storage.");
    },
  } as unknown as Session;

  return {
    network,
    session,
    names,
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
