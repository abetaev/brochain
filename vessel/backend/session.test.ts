// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Network, Peer } from "@c/backend/network";
import type { Roster } from "./roster.ts";

const dependencies = vi.hoisted(() => ({
  createLibp2p: vi.fn(),
  createNetwork: vi.fn(),
  createRoster: vi.fn(),
  generateKeyPairFromSeed: vi.fn(),
}));

vi.mock("@chainsafe/libp2p-noise", () => ({ noise: () => ({}) }));
vi.mock("@chainsafe/libp2p-yamux", () => ({ yamux: () => ({}) }));
vi.mock("@libp2p/circuit-relay-v2", () => ({ circuitRelayTransport: () => ({}) }));
vi.mock("@libp2p/crypto/keys", () => ({
  generateKeyPairFromSeed: dependencies.generateKeyPairFromSeed,
}));
vi.mock("@libp2p/identify", () => ({ identify: () => ({}), identifyPush: () => ({}) }));
vi.mock("@libp2p/webrtc", () => ({ webRTC: () => ({}) }));
vi.mock("@libp2p/websockets", () => ({ webSockets: () => ({}) }));
vi.mock("libp2p", () => ({ createLibp2p: dependencies.createLibp2p }));
vi.mock("@c/backend/network", () => ({ default: dependencies.createNetwork }));
vi.mock("@v/backend/roster", () => ({ createRoster: dependencies.createRoster }));

import { createSession } from "./session.ts";

interface TestRuntime {
  readonly beacon: Peer & { isConnected: ReturnType<typeof vi.fn> };
  readonly createdBeacon: Peer & { connect: ReturnType<typeof vi.fn> };
  readonly initializedPeer: Peer & { host: ReturnType<typeof vi.fn> };
  readonly network: Network & {
    createPeer: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  readonly node: {
    addEventListener: ReturnType<typeof vi.fn>;
    getMultiaddrs: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };
  readonly roster: Roster;
}

let runtime: TestRuntime;

beforeEach(() => {
  vi.stubGlobal("window", {
    location: { hostname: "localhost", protocol: "http:" },
  });
  dependencies.createLibp2p.mockReset();
  dependencies.createNetwork.mockReset();
  dependencies.createRoster.mockReset();
  dependencies.generateKeyPairFromSeed.mockReset();

  const beacon = {
    id: "beacon",
    isConnected: vi.fn(() => true),
  } as unknown as TestRuntime["beacon"];
  const createdBeacon = {
    id: "beacon",
    connect: vi.fn(async () => beacon),
  } as unknown as TestRuntime["createdBeacon"];
  const network = {
    id: "local",
    createPeer: vi.fn(async () => createdBeacon),
    close: vi.fn(async () => {}),
  } as unknown as TestRuntime["network"];
  const initializedPeer = {
    id: "remote",
    host: vi.fn(),
  } as unknown as TestRuntime["initializedPeer"];
  const node = {
    addEventListener: vi.fn(),
    getMultiaddrs: vi.fn(() => [{ toString: () => "/p2p-circuit/webrtc" }]),
    removeEventListener: vi.fn(),
    stop: vi.fn(async () => {}),
  };
  const roster = {
    list: vi.fn(async () => []),
    getPeer: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => {}),
  } as unknown as Roster;
  runtime = { beacon, createdBeacon, initializedPeer, network, node, roster };

  dependencies.generateKeyPairFromSeed.mockResolvedValue({});
  dependencies.createLibp2p.mockResolvedValue(node);
  dependencies.createNetwork.mockImplementation(async (
    _node: unknown,
    initialize?: (peer: Peer, network: Network) => void,
  ) => {
    initialize?.(initializedPeer, network);
    return network;
  });
  dependencies.createRoster.mockReturnValue(roster);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function openSession(closeAccountSession = vi.fn(async () => {})) {
  return createSession(
    async () => ({ username: "alice", identitySeed: "AA==" }),
    closeAccountSession,
  );
}

describe("Session access and lifetime", () => {
  it("lazily memoizes dependencies and privately bootstraps the default Beacon", async () => {
    const session = await openSession();
    expect(dependencies.createLibp2p).not.toHaveBeenCalled();

    const [firstNetwork, secondNetwork, firstRoster, secondRoster] = await Promise.all([
      session.network(),
      session.network(),
      session.roster(),
      session.roster(),
    ]);

    expect(firstNetwork).toBe(runtime.network);
    expect(secondNetwork).toBe(runtime.network);
    expect(firstRoster).toBe(runtime.roster);
    expect(secondRoster).toBe(runtime.roster);
    expect(dependencies.createLibp2p).toHaveBeenCalledOnce();
    expect(dependencies.createNetwork).toHaveBeenCalledOnce();
    expect(runtime.network.createPeer).toHaveBeenCalledOnce();
    expect(runtime.network.createPeer).toHaveBeenCalledWith(
      "/dns4/localhost/tcp/9090/ws",
    );
    expect(runtime.createdBeacon.connect).toHaveBeenCalledOnce();
    expect(runtime.node.getMultiaddrs).toHaveBeenCalled();
    expect(dependencies.createRoster).toHaveBeenCalledOnce();
    expect(runtime.initializedPeer.host.mock.calls.map(([name]) => name))
      .toEqual(["identity", "messaging"]);
    expect(runtime.initializedPeer.host.mock.invocationCallOrder.at(-1))
      .toBeLessThan(runtime.network.createPeer.mock.invocationCallOrder[0]!);
    expect(runtime.network.createPeer.mock.invocationCallOrder[0])
      .toBeLessThan(runtime.createdBeacon.connect.mock.invocationCallOrder[0]!);
    expect(runtime.createdBeacon.connect.mock.invocationCallOrder[0])
      .toBeLessThan(runtime.node.getMultiaddrs.mock.invocationCallOrder[0]!);

    expect(session.storage()).toBe(session.storage());
    expect(session.storage().peer("remote")).toBe(session.storage().peer("remote"));

    await session.close();
  });

  it("uses TLS when the Vessel page is served over HTTPS", async () => {
    vi.stubGlobal("window", {
      location: { hostname: "vessel.example", protocol: "https:" },
    });
    const session = await openSession();

    await session.network();

    expect(runtime.network.createPeer).toHaveBeenCalledWith(
      "/dns4/vessel.example/tcp/9090/tls/ws",
    );
    await session.close();
  });

  it("returns an offline Network after Peer creation fails and retries on access", async () => {
    runtime.network.createPeer
      .mockRejectedValueOnce(new Error("Beacon unavailable."))
      .mockResolvedValueOnce(runtime.createdBeacon);
    const session = await openSession();

    await expect(session.network()).resolves.toBe(runtime.network);
    expect(session.bootstrapError()).toBe("Beacon unavailable.");
    expect(runtime.createdBeacon.connect).not.toHaveBeenCalled();
    expect(runtime.node.getMultiaddrs).not.toHaveBeenCalled();

    await expect(session.network()).resolves.toBe(runtime.network);
    expect(runtime.network.createPeer).toHaveBeenCalledTimes(2);
    expect(session.bootstrapError()).toBeUndefined();

    await session.close();
  });

  it("does not test relay readiness after connection failure", async () => {
    runtime.createdBeacon.connect.mockRejectedValueOnce(new Error("Connection failed."));
    const session = await openSession();

    await expect(session.network()).resolves.toBe(runtime.network);

    expect(session.bootstrapError()).toBe("Connection failed.");
    expect(runtime.node.getMultiaddrs).not.toHaveBeenCalled();
    await session.close();
  });

  it("reports relay readiness failure without discarding the usable Network", async () => {
    runtime.node.getMultiaddrs.mockImplementationOnce(() => {
      throw new Error("Relay reservation failed.");
    });
    const session = await openSession();

    await expect(session.network()).resolves.toBe(runtime.network);

    expect(runtime.createdBeacon.connect).toHaveBeenCalledOnce();
    expect(session.bootstrapError()).toBe("Relay reservation failed.");
    await session.close();
  });

  it("waits for a delayed self-address update and cleans up readiness listeners", async () => {
    let advertised = false;
    runtime.node.getMultiaddrs.mockImplementation(() => advertised
      ? [{ toString: () => "/p2p-circuit/webrtc" }]
      : []);
    const session = await openSession();
    const access = session.network();
    await vi.waitFor(() => {
      expect(runtime.node.addEventListener).toHaveBeenCalledWith(
        "self:peer:update",
        expect.any(Function),
      );
    });
    const updated = runtime.node.addEventListener.mock.calls
      .find(([event]) => event === "self:peer:update")?.[1] as (() => void) | undefined;

    advertised = true;
    updated?.();

    await expect(access).resolves.toBe(runtime.network);
    expect(session.bootstrapError()).toBeUndefined();
    expect(runtime.node.removeEventListener).toHaveBeenCalledWith(
      "self:peer:update",
      updated,
    );
    await session.close();
  });

  it("reports relay timeout and removes the pending self-address listener", async () => {
    runtime.node.getMultiaddrs.mockReturnValue([]);
    const timeout = new AbortController();
    const removeAbortListener = vi.spyOn(timeout.signal, "removeEventListener");
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    vi.spyOn(AbortSignal, "any").mockReturnValue(timeout.signal);
    const session = await openSession();
    const access = session.network();
    await vi.waitFor(() => expect(runtime.node.addEventListener).toHaveBeenCalled());
    const updated = runtime.node.addEventListener.mock.calls
      .find(([event]) => event === "self:peer:update")?.[1];

    timeout.abort();

    await expect(access).resolves.toBe(runtime.network);
    expect(session.bootstrapError()).toBe(
      "The Beacon did not provide a relay reservation.",
    );
    expect(runtime.node.removeEventListener).toHaveBeenCalledWith(
      "self:peer:update",
      updated,
    );
    expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));
    await session.close();
  });

  it("aborts pending relay readiness and cleans up when the Session closes", async () => {
    runtime.node.getMultiaddrs.mockReturnValue([]);
    const combineSignals = AbortSignal.any.bind(AbortSignal);
    let readiness: AbortSignal | undefined;
    vi.spyOn(AbortSignal, "any").mockImplementation((signals) => {
      readiness = combineSignals(signals);
      return readiness;
    });
    const session = await openSession();
    const access = session.network();
    await vi.waitFor(() => {
      expect(runtime.node.addEventListener).toHaveBeenCalledWith(
        "self:peer:update",
        expect.any(Function),
      );
    });
    const removeAbortListener = vi.spyOn(readiness!, "removeEventListener");
    const updated = runtime.node.addEventListener.mock.calls
      .find(([event]) => event === "self:peer:update")?.[1];

    await session.close();

    await expect(access).rejects.toThrow("Session is closed");
    expect(session.bootstrapError()).toBe(
      "Peer networking was closed before WebRTC became available.",
    );
    expect(runtime.node.removeEventListener).toHaveBeenCalledWith(
      "self:peer:update",
      updated,
    );
    expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("retains the active Peer selected by connect and retries after it disconnects", async () => {
    const session = await openSession();

    await session.network();
    await session.network();
    expect(runtime.network.createPeer).toHaveBeenCalledOnce();

    runtime.beacon.isConnected.mockReturnValue(false);
    await expect(session.roster()).resolves.toBe(runtime.roster);

    expect(runtime.network.createPeer).toHaveBeenCalledTimes(2);
    expect(runtime.createdBeacon.connect).toHaveBeenCalledTimes(2);
    expect(dependencies.createNetwork).toHaveBeenCalledOnce();
    expect(dependencies.createRoster).toHaveBeenCalledOnce();

    await session.close();
  });

  it("closes safely while lazy Network initialization is still pending", async () => {
    let finishNetwork: ((network: Network) => void) | undefined;
    dependencies.createNetwork.mockImplementation(async () =>
      await new Promise<Network>((resolve) => {
        finishNetwork = resolve;
      })
    );
    const closeAccountSession = vi.fn(async () => {});
    const session = await openSession(closeAccountSession);
    const access = session.network();
    await vi.waitFor(() => expect(finishNetwork).toBeDefined());

    const firstClose = session.close();
    const secondClose = session.close();
    finishNetwork?.(runtime.network);

    await expect(Promise.all([firstClose, secondClose])).resolves.toEqual([undefined, undefined]);
    await expect(access).rejects.toThrow("Session is closed");
    expect(runtime.network.close).toHaveBeenCalledOnce();
    expect(closeAccountSession).toHaveBeenCalledOnce();
    expect(runtime.network.createPeer).not.toHaveBeenCalled();
    expect(() => session.storage()).toThrow("Session is closed");
  });

  it("closes Account access even when Network shutdown fails", async () => {
    const failure = new Error("Network shutdown failed.");
    runtime.network.close.mockRejectedValueOnce(failure);
    const closeAccountSession = vi.fn(async () => {});
    const session = await openSession(closeAccountSession);
    await session.network();

    await expect(session.close()).rejects.toBe(failure);
    expect(closeAccountSession).toHaveBeenCalledOnce();
    await expect(session.close()).rejects.toBe(failure);
    expect(runtime.network.close).toHaveBeenCalledOnce();
    expect(closeAccountSession).toHaveBeenCalledOnce();
  });
});
