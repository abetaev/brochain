// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Network as CommonNetwork,
  Peer,
  Services,
} from "@c/backend/network";

const dependencies = vi.hoisted(() => ({
  createCommonNetwork: vi.fn(),
  generateKeyPairFromSeed: vi.fn(),
}));

vi.mock("@chainsafe/libp2p-noise", () => ({ noise: () => ({ type: "noise" }) }));
vi.mock("@chainsafe/libp2p-yamux", () => ({ yamux: () => ({ type: "yamux" }) }));
vi.mock("@libp2p/circuit-relay-v2", () => ({
  circuitRelayTransport: () => ({ type: "relay" }),
}));
vi.mock("@libp2p/crypto/keys", () => ({
  generateKeyPairFromSeed: dependencies.generateKeyPairFromSeed,
}));
vi.mock("@libp2p/identify", () => ({
  identify: () => ({ type: "identify" }),
  identifyPush: () => ({ type: "identify-push" }),
}));
vi.mock("@libp2p/webrtc", () => ({ webRTC: () => ({ type: "webrtc" }) }));
vi.mock("@libp2p/websockets", () => ({ webSockets: () => ({ type: "websockets" }) }));
vi.mock("@c/backend/network", () => ({ default: dependencies.createCommonNetwork }));

import { createNetwork } from "./index.ts";

type TestNetwork = CommonNetwork & {
  readonly addresses: CommonNetwork["addresses"] & ReturnType<typeof vi.fn>;
  readonly subscribeAddresses: CommonNetwork["subscribeAddresses"] & ReturnType<typeof vi.fn>;
  readonly createPeer: CommonNetwork["createPeer"] & ReturnType<typeof vi.fn>;
  readonly close: CommonNetwork["close"] & ReturnType<typeof vi.fn>;
};

let network: TestNetwork;
let beacon: Peer & { readonly isConnected: ReturnType<typeof vi.fn> };
let createdBeacon: Peer & { readonly connect: ReturnType<typeof vi.fn> };
let advertised: string[];
let addressListeners: Set<() => void>;
let unsubscribeAddress: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("window", {
    location: { hostname: "localhost", protocol: "http:" },
  });
  dependencies.createCommonNetwork.mockReset();
  dependencies.generateKeyPairFromSeed.mockReset().mockResolvedValue({ type: "private-key" });
  advertised = ["/p2p-circuit/webrtc"];
  addressListeners = new Set();
  unsubscribeAddress = vi.fn();
  beacon = {
    id: "beacon",
    isConnected: vi.fn(() => true),
  } as unknown as typeof beacon;
  createdBeacon = {
    id: "beacon",
    connect: vi.fn(async () => beacon),
  } as unknown as typeof createdBeacon;
  network = {
    id: "local",
    addresses: vi.fn(() => Object.freeze([...advertised])),
    subscribeAddresses: vi.fn((listener: () => void) => {
      addressListeners.add(listener);
      unsubscribeAddress.mockImplementation(() => addressListeners.delete(listener));
      return unsubscribeAddress;
    }),
    createPeer: vi.fn(async () => createdBeacon),
    close: vi.fn(async () => {}),
  } as unknown as TestNetwork;
  dependencies.createCommonNetwork.mockResolvedValue(network);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Vessel Network construction", () => {
  it("eagerly initializes one configured Common Network and exposes its ID", async () => {
    const component = await createNetwork("alice", "AA==");

    expect(dependencies.generateKeyPairFromSeed).toHaveBeenCalledWith(
      "Ed25519",
      new Uint8Array([0]),
    );
    expect(dependencies.createCommonNetwork).toHaveBeenCalledOnce();
    expect(component.id).toBe("local");
    const [configuration, services] = dependencies.createCommonNetwork.mock.calls[0] as [
      Record<string, unknown>,
      Services,
    ];
    expect(configuration).not.toHaveProperty("start");
    expect(configuration).toMatchObject({
      privateKey: { type: "private-key" },
      addresses: { listen: ["/p2p-circuit", "/webrtc"] },
      connectionGater: { denyDialMultiaddr: expect.any(Function) },
    });
    expect(services).toEqual({ identity: { rpc: expect.any(Function) } });
    expect((services.identity?.rpc?.({ id: "remote" } as Peer, network) as {
      get(): { name: string };
    }).get()).toEqual({ name: "alice" });
    await component.close();
  });

  it("rejects construction when Common Network initialization fails", async () => {
    const failure = new Error("Network initialization failed.");
    dependencies.createCommonNetwork.mockRejectedValueOnce(failure);

    await expect(createNetwork("alice", "AA==")).rejects.toBe(failure);

    expect(dependencies.createCommonNetwork).toHaveBeenCalledOnce();
  });
});

describe("Vessel Network bootstrap", () => {
  it("connects the inferred default Beacon during construction", async () => {
    const component = await createNetwork("alice", "AA==");

    expect(network.createPeer).toHaveBeenCalledWith("/dns4/localhost/tcp/9090/ws");
    expect(createdBeacon.connect).toHaveBeenCalledOnce();
    expect(network.addresses).toHaveBeenCalled();
    expect(component.bootstrapError()).toBeUndefined();
    await component.close();
  });

  it("uses TLS when Vessel is served over HTTPS", async () => {
    vi.stubGlobal("window", {
      location: { hostname: "vessel.example", protocol: "https:" },
    });
    const component = await createNetwork("alice", "AA==");

    expect(network.createPeer).toHaveBeenCalledWith(
      "/dns4/vessel.example/tcp/9090/tls/ws",
    );
    await component.close();
  });

  it("returns an offline Network after bootstrap fails and retries on access", async () => {
    network.createPeer
      .mockRejectedValueOnce(new Error("Beacon unavailable."))
      .mockResolvedValueOnce(createdBeacon);
    const component = await createNetwork("alice", "AA==");

    expect(component.bootstrapError()).toBe("Beacon unavailable.");
    expect(createdBeacon.connect).not.toHaveBeenCalled();

    await expect(component.access()).resolves.toBe(network);
    expect(network.createPeer).toHaveBeenCalledTimes(2);
    expect(component.bootstrapError()).toBeUndefined();
    await component.close();
  });

  it("waits for address invalidation and releases the listener after WebRTC is ready", async () => {
    advertised = [];
    const construction = createNetwork("alice", "AA==");
    await vi.waitFor(() => expect(network.subscribeAddresses).toHaveBeenCalledOnce());

    advertised = ["/p2p-circuit/webrtc"];
    for (const listener of addressListeners) listener();

    const component = await construction;
    expect(unsubscribeAddress).toHaveBeenCalledOnce();
    expect(component.bootstrapError()).toBeUndefined();
    await component.close();
  });

  it("reports relay timeout and releases the address listener", async () => {
    advertised = [];
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    vi.spyOn(AbortSignal, "any").mockReturnValue(timeout.signal);
    const construction = createNetwork("alice", "AA==");
    await vi.waitFor(() => expect(network.subscribeAddresses).toHaveBeenCalledOnce());

    timeout.abort();

    const component = await construction;
    expect(component.bootstrapError()).toBe(
      "The Beacon did not provide a relay reservation.",
    );
    expect(unsubscribeAddress).toHaveBeenCalledOnce();
    await component.close();
  });

  it("retains a connected Beacon and retries after it disconnects", async () => {
    const component = await createNetwork("alice", "AA==");

    await component.access();
    await component.access();
    expect(network.createPeer).toHaveBeenCalledOnce();

    beacon.isConnected.mockReturnValue(false);
    await component.access();
    expect(network.createPeer).toHaveBeenCalledTimes(2);
    expect(createdBeacon.connect).toHaveBeenCalledTimes(2);
    expect(dependencies.createCommonNetwork).toHaveBeenCalledOnce();
    await component.close();
  });
});

describe("Vessel Network shutdown", () => {
  it("closes the Common Network once", async () => {
    const component = await createNetwork("alice", "AA==");

    await expect(Promise.all([component.close(), component.close()]))
      .resolves.toEqual([undefined, undefined]);
    expect(network.close).toHaveBeenCalledOnce();
  });

  it("cancels pending relay readiness without retaining a bootstrap error", async () => {
    const component = await createNetwork("alice", "AA==");
    advertised = [];
    beacon.isConnected.mockReturnValue(false);
    const access = component.access();
    await vi.waitFor(() => expect(network.subscribeAddresses).toHaveBeenCalledOnce());

    await component.close();

    await expect(access).resolves.toBe(network);
    expect(unsubscribeAddress).toHaveBeenCalledOnce();
    expect(component.bootstrapError()).toBeUndefined();
    expect(network.close).toHaveBeenCalledOnce();
  });
});
