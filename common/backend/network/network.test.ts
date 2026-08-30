// @vitest-environment node

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { identify, identifyPush } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { afterEach, describe, expect, it, vi } from "vitest";
import createNetwork, {
  type NetworkService,
  type NetworkServiceFactories,
  type NetworkServiceFactory,
  type Network,
  type NetworkConfiguration,
  type Peer,
  type ServicePublication,
} from "./index.ts";
import { addressWithPeerId, destinationPeerId } from "./peer.ts";
import {
  createDiscoveryHost,
  discoveryServiceName,
  discoveryUpdatesProtocol,
  readDiscoveryUpdates,
  type Discovery,
} from "./services/discovery.ts";
import { registryServiceName } from "./services/registry.ts";
import { createSignals } from "@v/backend/signals";
import {
  createMessaging,
  type MessagingEvent,
} from "@v/backend/network/services/messaging";

interface Echo {
  inspect(value: { payload: Uint8Array }): {
    caller: string;
    nested: { payload: Uint8Array };
  };
}

const networks: Network[] = [];

function rpc<Service extends object>(
  create: (peer: Peer, network: Network) => Service,
): NetworkServiceFactory {
  return (peer, network) => ({ rpc: create(peer, network) });
}

function discoveryFactory(
  discovery: ReturnType<typeof createDiscoveryHost>,
): NetworkServiceFactory {
  function factory(peer: Peer, network: Network): NetworkService {
    return {
      rpc: discovery.service(peer, network.connectedPeers),
      protocols: {
        [discoveryUpdatesProtocol]: async (stream) => {
          await discovery.updates.accept(peer, stream);
        },
      },
    };
  }
  factory.protocols = [{ id: discoveryUpdatesProtocol }];
  return factory;
}

async function localNetwork(
  factories: NetworkServiceFactories = {},
  shouldPublish?: ServicePublication,
  identifyPeers = true,
  privateKey?: NetworkConfiguration["privateKey"],
) {
  const network = await createNetwork({
    privateKey,
    addresses: { listen: ["/ip4/127.0.0.1/tcp/0/ws"] },
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: identifyPeers
      ? { identify: identify(), identifyPush: identifyPush() }
      : undefined,
  }, factories, shouldPublish);
  networks.push(network);
  const address = network.addresses()[0];
  if (address === undefined) throw new Error("Test peer did not expose an address.");
  return { network, address };
}

afterEach(async () => {
  await Promise.allSettled(networks.splice(0).map((network) => network.close()));
});

describe("Network and Peer identity", () => {
  it("reconstructs the destination of an Identify relay/WebRTC address", () => {
    const beaconId = "12D3KooWKnDdG3iXw9eTFijk3EWSunZcFi54Zka4wmtqtt6rPxc8";
    const vesselId = "12D3KooWQY1mzxK1TmJX9KhZBbPYANoLYv7SbjbR9diN7ykDFhFB";
    const identified =
      `/dns4/localhost/tcp/9090/ws/p2p/${beaconId}/p2p-circuit/webrtc/p2p/${vesselId}`;
    const pushed = identified.replace(`/p2p/${vesselId}`, "");

    expect(destinationPeerId(pushed)).toBeUndefined();
    expect(addressWithPeerId(pushed, vesselId)).toBe(identified);
    expect(destinationPeerId(identified)).toBe(vesselId);
  });

  it("constructs independent candidates and converges them on one connected Peer", async () => {
    const remote = await localNetwork();
    const local = await localNetwork();
    const alternate = remote.address.replace("/ip4/127.0.0.1", "/dns4/localhost");
    const first = await local.network.createPeer(remote.address, alternate);
    const second = await local.network.createPeer(alternate);

    expect(first).not.toBe(second);
    expect(local.network.connectedPeers()).toEqual([]);
    expect(await first.connect()).toBe(first);
    expect(await second.connect()).toBe(first);
    expect(first.services()).toEqual([]);
    await first.refreshServices();
    expect(first.services()).toEqual([registryServiceName]);
    expect(local.network.connectedPeers()).toEqual([first]);
  });

  it("coalesces concurrent identity-less authentication", async () => {
    const remote = await localNetwork();
    const local = await localNetwork();
    const address = remote.address.replace(/\/p2p\/[^/]+$/, "");

    const [first, second] = await Promise.all([
      local.network.createPeer(address),
      local.network.createPeer(address),
    ]);

    expect(second).toBe(first);
    expect(first.id).toBe(remote.network.id);
    expect(first.isConnected()).toBe(true);
  });

  it("emits a connected Peer after hosting services and loads its catalog later", async () => {
    const createdFor: string[] = [];
    const remote = await localNetwork({
      echo: rpc((peer) => {
        createdFor.push(peer.id);
        return { read: () => peer.id };
      }),
    });
    const local = await localNetwork();
    const events: string[] = [];
    const inbound = vi.fn();
    remote.network.subscribe((peer, event) => {
      if (event === "connected") inbound(peer);
    });
    local.network.subscribe((peer, event) => {
      events.push(event);
      if (event === "connected") {
        expect(peer.isConnected()).toBe(true);
        expect(peer.services()).toEqual([]);
      }
    });

    const peer = await (await local.network.createPeer(remote.address)).connect();

    expect(events).toEqual(["connected"]);
    await vi.waitFor(() => expect(inbound).toHaveBeenCalledOnce());
    expect(createdFor).toEqual([local.network.id]);
    await peer.refreshServices();
    expect(peer.services()).toEqual([registryServiceName, "echo"]);
    await expect(peer.service<{ read(): string }>("echo").read())
      .resolves.toBe(local.network.id);
  });

  it("terminates a connected Peer when its first Registry request fails", async () => {
    const remote = await localNetwork(
      {},
      (_peer, serviceName) => serviceName !== registryServiceName,
    );
    const local = await localNetwork();
    const events: string[] = [];
    local.network.subscribe((_peer, event) => events.push(event));

    const peer = await (await local.network.createPeer(remote.address)).connect();

    expect(peer.isConnected()).toBe(true);
    expect(events).toEqual(["connected"]);
    await expect(peer.refreshServices()).rejects.toThrow();
    expect(peer.isConnected()).toBe(false);
    expect(events).toEqual(["connected", "disconnected"]);
    expect(local.network.connectedPeers()).toEqual([]);
  });

  it("emits disconnect and removes the Peer after the last connection closes", async () => {
    const remote = await localNetwork();
    const local = await localNetwork();
    const peer = await (await local.network.createPeer(remote.address)).connect();
    const events: string[] = [];
    peer.subscribe((event) => events.push(event));

    await remote.network.close();

    await vi.waitFor(() => expect(peer.isConnected()).toBe(false));
    expect(events).toEqual(["disconnected"]);
    expect(local.network.connectedPeers()).toEqual([]);
  });

  it("delivers Discovery snapshots and patches over its peer-bound instance", async () => {
    const discovery = createDiscoveryHost();
    const beacon = await localNetwork({
      [discoveryServiceName]: discoveryFactory(discovery),
    });
    beacon.network.subscribe(discovery.peerChanged);
    const first = await localNetwork();
    const second = await localNetwork();
    const firstBeacon = await (await first.network.createPeer(beacon.address)).connect();
    await firstBeacon.refreshServices();
    const stream = await firstBeacon.open(discoveryUpdatesProtocol);
    const updates = readDiscoveryUpdates(stream);

    expect(await firstBeacon.service<Discovery>(discoveryServiceName).list()).toEqual([]);
    const next = updates.next();
    await (await second.network.createPeer(beacon.address)).connect();

    await expect(next).resolves.toEqual({
      done: false,
      value: {
        type: "set",
        peer: {
          peerId: second.network.id,
          addresses: expect.arrayContaining([second.address]),
        },
      },
    });
  });
});

describe("per-Peer service instances", () => {
  it("creates independent instances and publishes different catalogs per Peer", async () => {
    const allowed = await localNetwork();
    const created = new Map<string, object>();
    const remote = await localNetwork({
      audience: rpc((peer) => {
        const instance = { identify: () => peer.id };
        created.set(peer.id, instance);
        return instance;
      }),
      private: rpc(() => ({ read: () => "allowed" })),
    }, (peer, name) => name !== "private" || peer.id === allowed.network.id);
    const other = await localNetwork();
    const allowedRemote = await (await allowed.network.createPeer(remote.address)).connect();
    const otherRemote = await (await other.network.createPeer(remote.address)).connect();
    await Promise.all([
      allowedRemote.refreshServices(),
      otherRemote.refreshServices(),
    ]);

    expect(allowedRemote.services()).toEqual([registryServiceName, "audience", "private"]);
    expect(otherRemote.services()).toEqual([registryServiceName, "audience"]);
    expect(created.get(allowed.network.id)).not.toBe(created.get(other.network.id));
    await expect(allowedRemote.service<{ read(): string }>("private").read())
      .resolves.toBe("allowed");
    await expect(otherRemote.service<{ read(): string }>("private").read())
      .rejects.toThrow("does not provide");
  });

  it("routes authenticated RPC method objects and binary values", async () => {
    const remote = await localNetwork({
      echo: rpc((peer): Echo => ({
        inspect: ({ payload }) => ({ caller: peer.id, nested: { payload } }),
      })),
    });
    const local = await localNetwork();
    const peer = await (await local.network.createPeer(remote.address)).connect();
    await peer.refreshServices();
    const payload = new Uint8Array([0, 1, 127, 255]);

    const response = await peer.service<Echo>("echo").inspect({ payload });

    expect(response.caller).toBe(local.network.id);
    expect([...response.nested.payload]).toEqual([...payload]);
  });

  it("handles a message on the inbound side immediately after connect", async () => {
    const localMessaging = createMessaging(createSignals());
    const remoteMessaging = createMessaging(createSignals());
    const remote = await localNetwork({ messaging: remoteMessaging.factory });
    const local = await localNetwork({ messaging: localMessaging.factory });
    const received: MessagingEvent[] = [];
    remoteMessaging.events.subscribe((event) => received.push(event));
    const peer = await (await local.network.createPeer(remote.address)).connect();
    await peer.refreshServices();

    localMessaging.send(peer, { id: "immediate", text: "hello" });

    await vi.waitFor(() => expect(received).toEqual([{
      peerId: local.network.id,
      type: "received",
      message: { id: "immediate", text: "hello" },
    }]));
  });

  it("publishes and removes one service dynamically, visible on refresh", async () => {
    let generation = 0;
    const remote = await localNetwork({
      changing: rpc(() => {
        const current = ++generation;
        return { read: () => current };
      }),
    });
    const local = await localNetwork();
    const peer = await (await local.network.createPeer(remote.address)).connect();
    await peer.refreshServices();
    await vi.waitFor(() => expect(remote.network.connectedPeers()).toHaveLength(1));
    const inbound = remote.network.connectedPeers()[0];
    if (inbound === undefined) throw new Error("Remote did not retain the connected Peer.");
    const service = peer.service<{ read(): number }>("changing");

    await expect(service.read()).resolves.toBe(1);
    remote.network.publish(inbound, "changing", false);
    expect(remote.network.services()).toEqual(["registry", "changing"]);
    const events: string[] = [];
    local.network.subscribe((_peer, event) => events.push(event));
    await peer.refreshServices();
    expect(peer.services()).toEqual([registryServiceName]);
    expect(events).toEqual(["services"]);
    await expect(service.read()).rejects.toThrow("does not provide");

    remote.network.publish(inbound, "changing", true);
    await peer.refreshServices();
    await expect(service.read()).resolves.toBe(2);
  });

  it("keeps an accepted stream alive while rejecting new streams after removal", async () => {
    const protocol = "/brochain/test-bytes/1.0.0";
    let accepted!: () => void;
    const firstAccepted = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const bytes = (): NetworkService => ({
      protocols: {
        [protocol]: async (stream) => {
          accepted();
          for await (const chunk of stream) await stream.write(chunk);
          await stream.close();
        },
      },
    });
    bytes.protocols = [{ id: protocol, maxInboundStreams: 2, maxOutboundStreams: 2 }];
    const remote = await localNetwork({ bytes });
    const local = await localNetwork({ bytes });
    const peer = await (await local.network.createPeer(remote.address)).connect();
    await peer.refreshServices();
    await vi.waitFor(() => expect(remote.network.connectedPeers()).toHaveLength(1));
    const inbound = remote.network.connectedPeers()[0];
    if (inbound === undefined) throw new Error("Remote did not retain the connected Peer.");
    const stream = await peer.open(protocol);
    await firstAccepted;

    remote.network.publish(inbound, "bytes", false);
    await peer.refreshServices();
    await stream.write(new Uint8Array([1, 2, 3]));
    await stream.close();
    const received: number[] = [];
    for await (const bytes of stream) received.push(...bytes);
    expect(received).toEqual([1, 2, 3]);
    await expect(peer.open(protocol)).rejects.toThrow("does not provide");

    remote.network.publish(inbound, "bytes", true);
    await peer.refreshServices();
    const restored = await peer.open(protocol);
    await restored.write(new Uint8Array([4]));
    await restored.close();
    const restoredBytes: number[] = [];
    for await (const bytes of restored) restoredBytes.push(...bytes);
    expect(restoredBytes).toEqual([4]);
  });

  it("validates fixed service factories", async () => {
    await expect(localNetwork({
      invalid: {} as NetworkServiceFactory,
    })).rejects.toThrow("must be a function");
    const invalid = () => ({ protocols: { "/invalid": async () => {} } });
    invalid.protocols = [{ id: "/invalid", maxInboundStreams: 0 }];
    await expect(localNetwork({ invalid })).rejects.toThrow("positive integer");
    const duplicate = { id: "/duplicate" };
    const first = () => ({ protocols: { "/duplicate": async () => {} } });
    first.protocols = [duplicate];
    const second = () => ({ protocols: { "/duplicate": async () => {} } });
    second.protocols = [duplicate];
    await expect(localNetwork({
      first,
      second,
    })).rejects.toThrow("already provided");
  });

  it("does not call service factories before a Peer connects", async () => {
    const create = vi.fn(() => ({ rpc: { read: () => "ready" } }));
    const network = await localNetwork({ dormant: create });

    expect(create).not.toHaveBeenCalled();
    expect(network.network.services()).toEqual(["registry", "dormant"]);
  });

  it("keeps a shared identity when two transports converge", async () => {
    const identity = await generateKeyPair("Ed25519");
    const first = await localNetwork({}, undefined, true, identity);
    const second = await localNetwork({}, undefined, true, identity);
    expect(first.network.id).toBe(second.network.id);
  });
});
