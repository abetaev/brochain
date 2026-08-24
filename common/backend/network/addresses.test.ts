// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const dependency = vi.hoisted(() => ({ createLibp2p: vi.fn() }));

vi.mock("libp2p", () => ({ createLibp2p: dependency.createLibp2p }));

import createNetwork, { type NetworkConfiguration } from "./index.ts";

let addresses: string[];
let listeners: Map<string, Set<() => void>>;
let node: {
  readonly peerId: { toString(): string };
  readonly getMultiaddrs: ReturnType<typeof vi.fn>;
  readonly getConnections: ReturnType<typeof vi.fn>;
  readonly addEventListener: ReturnType<typeof vi.fn>;
  readonly handle: ReturnType<typeof vi.fn>;
  readonly unhandle: ReturnType<typeof vi.fn>;
  readonly start: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  dependency.createLibp2p.mockReset();
  addresses = ["/ip4/127.0.0.1/tcp/1000/ws/p2p/local"];
  listeners = new Map();
  node = {
    peerId: { toString: () => "local" },
    getMultiaddrs: vi.fn(() => addresses.map((address) => ({
      toString: () => address,
    }))),
    getConnections: vi.fn(() => []),
    addEventListener: vi.fn((event: string, listener: () => void) => {
      let registered = listeners.get(event);
      if (registered === undefined) {
        registered = new Set();
        listeners.set(event, registered);
      }
      registered.add(listener);
    }),
    handle: vi.fn(async () => {}),
    unhandle: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  dependency.createLibp2p.mockResolvedValue(node);
});

describe("Network-owned libp2p runtime", () => {
  it("creates the node with deferred startup and closes it once", async () => {
    const configuration = { start: true } as unknown as NetworkConfiguration;

    const network = await createNetwork(configuration);

    expect(dependency.createLibp2p).toHaveBeenCalledWith({ start: false });
    expect(node.handle).toHaveBeenCalledBefore(node.start);
    await Promise.all([network.close(), network.close()]);
    expect(node.stop).toHaveBeenCalledOnce();
  });

  it("returns immutable address snapshots", async () => {
    const network = await createNetwork({});

    const first = network.addresses();
    addresses.push("/ip4/127.0.0.1/tcp/2000/ws/p2p/local");

    expect(Object.isFrozen(first)).toBe(true);
    expect(first).toEqual(["/ip4/127.0.0.1/tcp/1000/ws/p2p/local"]);
    expect(network.addresses()).toEqual([
      "/ip4/127.0.0.1/tcp/1000/ws/p2p/local",
      "/ip4/127.0.0.1/tcp/2000/ws/p2p/local",
    ]);
    await network.close();
  });

  it("publishes ordered address invalidations without replay", async () => {
    const network = await createNetwork({});
    const events: string[] = [];
    const unsubscribe = network.subscribeAddresses(() => events.push("first"));
    network.subscribeAddresses(() => events.push("second"));

    expect(events).toEqual([]);
    for (const listener of listeners.get("self:peer:update") ?? []) listener();
    expect(events).toEqual(["first", "second"]);

    unsubscribe();
    unsubscribe();
    for (const listener of listeners.get("self:peer:update") ?? []) listener();
    expect(events).toEqual(["first", "second", "second"]);
    await network.close();
  });
});
