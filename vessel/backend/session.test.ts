// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Network, Peer, Services } from "@c/backend/network";
import type { Options } from "./options";

const dependencies = vi.hoisted(() => ({
  createLibp2p: vi.fn(),
  createNetwork: vi.fn(),
  createOptions: vi.fn(),
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
vi.mock("@v/backend/options", () => ({ createOptions: dependencies.createOptions }));

import { createSession } from "./session.ts";

interface TestRuntime {
  readonly beacon: Peer & { isConnected: ReturnType<typeof vi.fn> };
  readonly createdBeacon: Peer & { connect: ReturnType<typeof vi.fn> };
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
}

let runtime: TestRuntime;
let options: Options;

beforeEach(() => {
  vi.stubGlobal("window", {
    location: { hostname: "localhost", protocol: "http:" },
  });
  dependencies.createLibp2p.mockReset();
  dependencies.createNetwork.mockReset();
  dependencies.createOptions.mockReset();
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
  const node = {
    addEventListener: vi.fn(),
    getMultiaddrs: vi.fn(() => [{ toString: () => "/p2p-circuit/webrtc" }]),
    removeEventListener: vi.fn(),
    stop: vi.fn(async () => {}),
  };
  runtime = { beacon, createdBeacon, network, node };
  options = {
    changes: {
      publish: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    },
    get: vi.fn(),
    set: vi.fn(async () => {}),
    unset: vi.fn(async () => {}),
  };

  dependencies.generateKeyPairFromSeed.mockResolvedValue({});
  dependencies.createLibp2p.mockResolvedValue(node);
  dependencies.createNetwork.mockResolvedValue(network);
  dependencies.createOptions.mockResolvedValue(options);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function openSession(closeAccountSession = vi.fn(async () => {})) {
  return createSession(
    async () => ({
      username: "alice",
      identitySeed: "AA==",
    }),
    closeAccountSession,
  );
}

describe("Session access and lifetime", () => {
  it("lazily memoizes dependencies and privately bootstraps the default Beacon", async () => {
    const session = await openSession();
    expect(dependencies.createLibp2p).not.toHaveBeenCalled();

    const [firstNetwork, secondNetwork] = await Promise.all([
      session.network(),
      session.network(),
    ]);

    expect(firstNetwork).toBe(runtime.network);
    expect(secondNetwork).toBe(runtime.network);
    expect(dependencies.createLibp2p).toHaveBeenCalledOnce();
    expect(dependencies.createNetwork).toHaveBeenCalledOnce();
    expect(runtime.network.createPeer).toHaveBeenCalledOnce();
    expect(runtime.network.createPeer).toHaveBeenCalledWith(
      "/dns4/localhost/tcp/9090/ws",
    );
    expect(runtime.createdBeacon.connect).toHaveBeenCalledOnce();
    expect(runtime.node.getMultiaddrs).toHaveBeenCalled();
    const services = dependencies.createNetwork.mock.calls[0]?.[1] as Services;
    expect(services).toEqual({ identity: { rpc: expect.any(Function) } });
    expect((services.identity?.rpc?.({ id: "remote" } as Peer, runtime.network) as {
      get(): { name: string };
    }).get()).toEqual({ name: "alice" });
    expect(dependencies.createNetwork.mock.invocationCallOrder[0])
      .toBeLessThan(runtime.network.createPeer.mock.invocationCallOrder[0]!);
    expect(runtime.network.createPeer.mock.invocationCallOrder[0])
      .toBeLessThan(runtime.createdBeacon.connect.mock.invocationCallOrder[0]!);
    expect(runtime.createdBeacon.connect.mock.invocationCallOrder[0])
      .toBeLessThan(runtime.node.getMultiaddrs.mock.invocationCallOrder[0]!);

    const storage = session.storage();
    const persistent = session.storage({ persistent: true });
    const closeStorage = vi.spyOn(storage, "close");
    expect(storage).toBe(session.storage());
    expect(storage).toBe(session.storage({ persistent: false }));
    expect(persistent).toBe(session.storage({ persistent: true }));
    expect(persistent).not.toBe(storage);
    expect(storage.peer("remote")).toBe(storage.peer("remote"));
    expect(persistent.peer("remote")).toBe(persistent.peer("remote"));
    expect(persistent.peer("remote").service("options").kv())
      .toBe(persistent.peer("remote").service("options").kv());
    expect("event" in persistent.peer("remote").service("options")).toBe(false);
    expect("fs" in persistent.peer("remote").service("options")).toBe(false);
    expect(session.signals()).toBe(session.signals());

    await session.close();
    expect(closeStorage).toHaveBeenCalledOnce();
  });

  it("isolates Signals between Sessions", async () => {
    const first = await openSession();
    const second = await openSession();
    const owner = {};
    const firstChannel = first.signals().channel<string>(owner, "events");
    const secondChannel = second.signals().channel<string>(owner, "events");
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    firstChannel.subscribe(firstListener);
    secondChannel.subscribe(secondListener);

    expect(first.signals()).not.toBe(second.signals());
    expect(firstChannel).not.toBe(secondChannel);
    firstChannel.publish("first");
    expect(firstListener).toHaveBeenCalledWith("first");
    expect(secondListener).not.toHaveBeenCalled();

    await Promise.all([first.close(), second.close()]);
  });

  it("memoizes Options in the local peer scope without Beacon bootstrap", async () => {
    const session = await openSession();
    const service = session.storage({ persistent: true })
      .peer("local")
      .service("options");

    const [first, second] = await Promise.all([
      session.options(),
      session.options(),
    ]);

    expect(first).toBe(options);
    expect(second).toBe(options);
    expect(dependencies.createOptions).toHaveBeenCalledOnce();
    expect(dependencies.createOptions).toHaveBeenCalledWith(
      service,
      session.signals(),
    );
    expect(dependencies.createLibp2p).toHaveBeenCalledOnce();
    expect(dependencies.createNetwork).toHaveBeenCalledOnce();
    expect(runtime.network.createPeer).not.toHaveBeenCalled();
    await session.close();
  });

  it("reports Options initialization failure and retries it", async () => {
    const failure = new Error("Options initialization failed.");
    dependencies.createOptions
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(options);
    const session = await openSession();

    await expect(session.options()).rejects.toBe(failure);
    await expect(session.options()).resolves.toBe(options);

    expect(dependencies.createOptions).toHaveBeenCalledTimes(2);
    expect(dependencies.createNetwork).toHaveBeenCalledOnce();
    expect(runtime.network.createPeer).not.toHaveBeenCalled();
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
    await expect(session.network()).resolves.toBe(runtime.network);

    expect(runtime.network.createPeer).toHaveBeenCalledTimes(2);
    expect(runtime.createdBeacon.connect).toHaveBeenCalledTimes(2);
    expect(dependencies.createNetwork).toHaveBeenCalledOnce();

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
    const closeStorage = vi.spyOn(session.storage(), "close");
    const access = session.network();
    await vi.waitFor(() => expect(finishNetwork).toBeDefined());

    const firstClose = session.close();
    const secondClose = session.close();
    finishNetwork?.(runtime.network);

    await expect(Promise.all([firstClose, secondClose])).resolves.toEqual([undefined, undefined]);
    await expect(access).rejects.toThrow("Session is closed");
    expect(runtime.network.close).toHaveBeenCalledOnce();
    expect(closeStorage).toHaveBeenCalledOnce();
    expect(closeAccountSession).toHaveBeenCalledOnce();
    expect(runtime.network.createPeer).not.toHaveBeenCalled();
    expect(() => session.signals()).toThrow("Session is closed");
    expect(() => session.storage()).toThrow("Session is closed");
    await expect(session.options()).rejects.toThrow("Session is closed");
  });

  it("closes Account access even when Storage shutdown fails", async () => {
    const failure = new Error("Storage shutdown failed.");
    const closeAccountSession = vi.fn(async () => {});
    const session = await openSession(closeAccountSession);
    const closeStorage = vi.spyOn(session.storage(), "close").mockRejectedValue(failure);

    await expect(session.close()).rejects.toBe(failure);
    expect(closeStorage).toHaveBeenCalledOnce();
    expect(closeAccountSession).toHaveBeenCalledOnce();
    await expect(session.close()).rejects.toBe(failure);
    expect(closeStorage).toHaveBeenCalledOnce();
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
