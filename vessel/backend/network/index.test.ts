// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Channel,
} from "@c/backend/signals";
import type {
  Network as CommonNetwork,
  NetworkServiceFactories,
  Peer,
  NetworkUpdate,
  ServicePublication,
} from "@c/backend/network";
import type { Options } from "@v/backend/options";

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
vi.mock("@libp2p/peer-id", () => ({
  peerIdFromPrivateKey: () => ({ toString: () => localPeerId }),
}));
vi.mock("@libp2p/identify", () => ({
  identify: () => ({ type: "identify" }),
  identifyPush: () => ({ type: "identify-push" }),
}));
vi.mock("@libp2p/webrtc", () => ({ webRTC: () => ({ type: "webrtc" }) }));
vi.mock("@libp2p/websockets", () => ({ webSockets: () => ({ type: "websockets" }) }));
vi.mock("@c/backend/network", () => ({ default: dependencies.createCommonNetwork }));

import signals from "@c/backend/signals";
import { createNetwork } from "./index.ts";

type TestNetwork = CommonNetwork & {
  readonly createPeer: CommonNetwork["createPeer"] & ReturnType<typeof vi.fn>;
  readonly publish: CommonNetwork["publish"] & ReturnType<typeof vi.fn>;
  readonly close: CommonNetwork["close"] & ReturnType<typeof vi.fn>;
};

let common: TestNetwork;
let commonUpdates: Channel<NetworkUpdate>;
let factories: NetworkServiceFactories;
let publication: ServicePublication;
let optionValues: Map<string, boolean>;
let optionListeners: Map<string, Set<(value: boolean | undefined) => unknown>>;
let connected: TestPeer[];

// This peer, which the connection profile is configured under like any other.
const localPeerId = "local";

// The published instances are what a publication decision produces, so the fake
// Peer holds them and the fake Network maintains them.
type TestPeer = Peer & { readonly hosted: Set<string> };

function peer(id = "remote"): TestPeer {
  const hosted = new Set<string>();
  return {
    id,
    hosted,
    addresses: () => [],
    services: () => ["registry", "identity", "messaging", "data-transfer"],
    isConnected: () => true,
    connect: vi.fn(),
    disconnect: vi.fn(async () => {}),
    refreshServices: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    hosts: (name: string) => hosted.has(name),
    service: vi.fn(),
  } as unknown as TestPeer;
}

// Connection publishes whatever the decision permits, the way Common Network does.
function connect(remote: TestPeer): void {
  for (const serviceName of common.services()) {
    if (publication(remote, serviceName)) remote.hosted.add(serviceName);
  }
  connected.push(remote);
  commonUpdates.publish({ type: "connected", peer: remote });
}

function optionCategory(path: string) {
  return { obj: (identifier: string) => optionObject(`${path}/${identifier}`) };
}

function optionObject(path: string) {
  return {
    get: (name: string) => optionValues.get(`${path}.${name}`),
    set: async (name: string, value: boolean) => setOption(`${path}.${name}`, value),
    observe: (name: string, listener: (value: boolean | undefined) => unknown) => {
      const key = `${path}.${name}`;
      let observers = optionListeners.get(key);
      if (observers === undefined) {
        observers = new Set();
        optionListeners.set(key, observers);
      }
      observers.add(listener);
      return () => observers?.delete(listener);
    },
    cat: (name: string) => optionCategory(`${path}/${name}`),
  };
}

function options(): Options {
  return { cat: optionCategory } as unknown as Options;
}

function setOption(key: string, value: boolean): void {
  optionValues.set(key, value);
  for (const observer of optionListeners.get(key) ?? []) observer(value);
}

function serviceKey(peerId: string, serviceName: string): string {
  return `peers/${peerId}/services/${serviceName}.enabled`;
}

function profileKey(serviceName: string): string {
  return serviceKey(localPeerId, serviceName);
}

beforeEach(() => {
  optionValues = new Map();
  optionListeners = new Map();
  connected = [];
  commonUpdates = signals.channel<NetworkUpdate>();
  factories = {};
  publication = () => true;
  common = {
    id: localPeerId,
    createPeer: vi.fn(),
    connectedPeers: vi.fn(() => connected),
    services: vi.fn(() => ["registry", ...Object.keys(factories)]),
    publish: vi.fn(async (target: TestPeer, serviceName: string, enabled: boolean) => {
      if (enabled) target.hosted.add(serviceName);
      else target.hosted.delete(serviceName);
    }),
    updates: commonUpdates,
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

  // Registry alone keeps a stranger connected long enough to be decided about.
  it("grants a peer nothing but Registry while the profile grants nothing", async () => {
    await createNetwork("AA==", "alice", options());

    expect(publication(peer("first"), "registry")).toBe(true);
    expect(publication(peer("first"), "messaging")).toBe(false);
    expect(publication(peer("first"), "identity")).toBe(false);
  });

  it("reads the profile for every peer, and a peer's own decision before it", async () => {
    optionValues.set(profileKey("messaging"), true);
    optionValues.set(serviceKey("first", "messaging"), false);
    optionValues.set(serviceKey("second", "calling"), true);
    await createNetwork("AA==", "alice", options());

    expect(publication(peer("first"), "messaging")).toBe(false);
    expect(publication(peer("second"), "messaging")).toBe(true);
    expect(publication(peer("second"), "calling")).toBe(true);
    expect(publication(peer("first"), "calling")).toBe(false);
  });

  it("re-decides every connected peer when the profile changes", async () => {
    await createNetwork("AA==", "alice", options());
    const following = peer("following");
    const deciding = peer("deciding");
    optionValues.set(serviceKey(deciding.id, "messaging"), false);

    connect(following);
    connect(deciding);
    setOption(profileKey("messaging"), true);

    expect(following.hosts("messaging")).toBe(true);
    expect(deciding.hosts("messaging")).toBe(false);
  });

  it("closes a peer it may publish no Registry to, as it connects and while it is", async () => {
    await createNetwork("AA==", "alice", options());
    const refused = peer("refused");
    const listed = peer("listed");
    optionValues.set(serviceKey(refused.id, "registry"), false);

    connect(refused);
    connect(listed);

    // The connection goes once the peer has been told what it may now reach.
    expect([...refused.hosted]).toEqual([]);
    await vi.waitFor(() => expect(refused.disconnect).toHaveBeenCalledOnce());
    expect(listed.disconnect).not.toHaveBeenCalled();

    setOption(serviceKey(listed.id, "registry"), false);

    expect([...listed.hosted]).toEqual([]);
    await vi.waitFor(() => expect(listed.disconnect).toHaveBeenCalledOnce());
  });

  it("decides nothing about a peer it reaches out to", async () => {
    const component = await createNetwork("AA==", "alice", options());
    const remote = peer();
    common.createPeer.mockResolvedValue(remote);
    (remote.connect as ReturnType<typeof vi.fn>).mockResolvedValue(remote);

    await component.connect("/dns4/example.com/tcp/443/tls/ws");

    expect(optionValues.size).toBe(0);
    expect(remote.connect).toHaveBeenCalledOnce();
  });

  it("applies option changes while connected and stops at disconnection", async () => {
    const component = await createNetwork("AA==", "alice", options());
    const observed: NetworkUpdate[] = [];
    component.updates.subscribe((update) => observed.push(update));
    const remote = peer();
    optionValues.set(profileKey("messaging"), true);

    connect(remote);
    setOption(serviceKey(remote.id, "messaging"), false);
    commonUpdates.publish({ type: "disconnected", peerId: remote.id });
    setOption(serviceKey(remote.id, "messaging"), true);

    expect(observed).toEqual([
      { type: "connected", peer: remote },
      { type: "disconnected", peerId: remote.id },
    ]);
    expect(common.publish).toHaveBeenCalledExactlyOnceWith(remote, "messaging", false);
  });

  it("closes the Common Network once and removes option observers", async () => {
    const component = await createNetwork("AA==", "alice", options());
    const remote = peer();
    connect(remote);

    await Promise.all([component.close(), component.close()]);
    setOption(serviceKey(remote.id, "identity"), true);
    setOption(profileKey("identity"), true);

    expect(common.close).toHaveBeenCalledOnce();
    expect(common.publish).not.toHaveBeenCalled();
  });

});
