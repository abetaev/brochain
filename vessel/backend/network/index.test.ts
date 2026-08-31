// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Network as CommonNetwork,
  NetworkServiceFactories,
  Peer,
  PeerEvent,
  ServicePublication,
} from "@c/backend/network";
import type { Options } from "@v/backend/options";
import { createSignals } from "@v/backend/signals";

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

import { createNetwork, type NetworkUpdate } from "./index.ts";

type TestNetwork = CommonNetwork & {
  readonly createPeer: CommonNetwork["createPeer"] & ReturnType<typeof vi.fn>;
  readonly publish: CommonNetwork["publish"] & ReturnType<typeof vi.fn>;
  readonly close: CommonNetwork["close"] & ReturnType<typeof vi.fn>;
};

let common: TestNetwork;
let listener: ((peer: Peer, event: PeerEvent) => void) | undefined;
let factories: NetworkServiceFactories;
let publication: ServicePublication;
let optionValues: Map<string, boolean>;
let optionListeners: Map<string, Set<(value: boolean | undefined) => unknown>>;

function peer(id = "remote"): Peer {
  return {
    id,
    addresses: () => [],
    services: () => ["registry", "identity", "messaging", "data-transfer"],
    isConnected: () => true,
    connect: vi.fn(),
    refreshServices: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    service: vi.fn(),
    remote: vi.fn(),
  } as unknown as Peer;
}

function options(): Options {
  return {
    cat: () => ({
      obj: (peerId: string) => ({
        cat: () => ({
          obj: (serviceName: string) => {
            const key = `${peerId}/${serviceName}`;
            return {
              get: () => optionValues.get(key),
              observe: (_name: string, current: (value: boolean | undefined) => unknown) => {
                let observers = optionListeners.get(key);
                if (observers === undefined) {
                  observers = new Set();
                  optionListeners.set(key, observers);
                }
                observers.add(current);
                return () => observers?.delete(current);
              },
            };
          },
        }),
      }),
    }),
  } as unknown as Options;
}

function setOption(peerId: string, serviceName: string, value: boolean): void {
  const key = `${peerId}/${serviceName}`;
  optionValues.set(key, value);
  for (const observer of optionListeners.get(key) ?? []) observer(value);
}

beforeEach(() => {
  optionValues = new Map();
  optionListeners = new Map();
  listener = undefined;
  factories = {};
  publication = () => true;
  common = {
    id: "local",
    createPeer: vi.fn(),
    connectedPeers: vi.fn(() => []),
    services: vi.fn(() => ["registry", ...Object.keys(factories)]),
    publish: vi.fn(),
    subscribe: vi.fn((next: (peer: Peer, event: PeerEvent) => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    }),
    close: vi.fn(async () => {}),
  } as unknown as TestNetwork;
  dependencies.generateKeyPairFromSeed.mockReset().mockResolvedValue({ type: "private-key" });
  dependencies.createCommonNetwork.mockReset().mockImplementation(
    async (
      _configuration: unknown,
      supplied: NetworkServiceFactories,
      shouldPublish: ServicePublication,
    ) => {
      factories = supplied;
      publication = shouldPublish;
      return common;
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Vessel Network", () => {
  it("constructs one Common Network with fixed service factories", async () => {
    const component = await createNetwork(
      "AA==",
      "alice",
      options(),
      createSignals(),
    );

    expect(dependencies.generateKeyPairFromSeed).toHaveBeenCalledWith(
      "Ed25519",
      new Uint8Array([0]),
    );
    expect(dependencies.createCommonNetwork).toHaveBeenCalledOnce();
    expect(Object.keys(factories)).toEqual(["identity", "messaging", "data-transfer"]);
    expect(factories.identity?.(peer()).remote).toMatchObject({
      get: expect.any(Function),
    });
    expect(component.id).toBe("local");
    expect(factories.messaging?.(peer())).toMatchObject({
      remote: { send: expect.any(Function) },
      send: expect.any(Function),
      updates: { publish: expect.any(Function), subscribe: expect.any(Function) },
    });
  });

  it("reads publication centrally for every service", async () => {
    optionValues.set("first/messaging", false);
    optionValues.set("first/registry", false);
    await createNetwork("AA==", "alice", options(), createSignals());

    expect(publication(peer("first"), "identity")).toBe(true);
    expect(publication(peer("first"), "messaging")).toBe(false);
    expect(publication(peer("first"), "registry")).toBe(false);
    expect(publication(peer("second"), "messaging")).toBe(true);
  });

  it("connects only when the direct action is called", async () => {
    const connected = peer("beacon");
    const candidate = { connect: vi.fn(async () => connected) } as unknown as Peer;
    common.createPeer.mockResolvedValue(candidate);
    const component = await createNetwork("AA==", "alice", options(), createSignals());

    expect(common.createPeer).not.toHaveBeenCalled();
    await expect(component.connect("/dns4/beacon/tcp/9090/ws", "/dns4/other/tcp/9090/ws"))
      .resolves.toBe(connected);
    expect(common.createPeer).toHaveBeenCalledWith(
      "/dns4/beacon/tcp/9090/ws",
      "/dns4/other/tcp/9090/ws",
    );
    expect(candidate.connect).toHaveBeenCalledOnce();
  });

  it("publishes keyed completed-peer patches and applies option changes", async () => {
    const signals = createSignals();
    const component = await createNetwork("AA==", "alice", options(), signals);
    const updates: NetworkUpdate[] = [];
    component.updates.subscribe((update) => updates.push(update));
    const remote = peer();

    listener?.(remote, "connected");
    listener?.(remote, "addresses");
    listener?.(remote, "services");
    setOption(remote.id, "messaging", false);
    setOption(remote.id, "registry", false);
    listener?.(remote, "disconnected");
    setOption(remote.id, "messaging", true);

    expect(updates).toEqual([
      { type: "set", peer: remote, changed: "connection" },
      { type: "set", peer: remote, changed: "addresses" },
      { type: "set", peer: remote, changed: "services" },
      {
        type: "set",
        peer: remote,
        changed: "publication",
        serviceName: "messaging",
        enabled: false,
      },
      {
        type: "set",
        peer: remote,
        changed: "publication",
        serviceName: "registry",
        enabled: false,
      },
      { type: "remove", peerId: remote.id },
    ]);
    expect(common.publish).toHaveBeenCalledWith(remote, "messaging", false);
    expect(common.publish).toHaveBeenCalledWith(remote, "registry", false);
    expect(common.publish).toHaveBeenCalledTimes(2);
  });

  it("closes the Common Network once and removes option observers", async () => {
    const component = await createNetwork("AA==", "alice", options(), createSignals());
    const remote = peer();
    listener?.(remote, "connected");

    await Promise.all([component.close(), component.close()]);
    setOption(remote.id, "identity", false);

    expect(common.close).toHaveBeenCalledOnce();
    expect(common.publish).not.toHaveBeenCalled();
  });

  it("rejects construction when Common Network initialization fails", async () => {
    const failure = new Error("Network initialization failed.");
    dependencies.createCommonNetwork.mockRejectedValueOnce(failure);

    await expect(createNetwork("AA==", "alice", options(), createSignals()))
      .rejects.toBe(failure);
  });
});
