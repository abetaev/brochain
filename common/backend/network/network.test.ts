// @vitest-environment node

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { identify, identifyPush } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createChannel, type Channel } from "../channel.ts";
import createNetwork, {
  createData,
  type Data,
  type NetworkServiceFactories,
  type NetworkServiceFactory,
  type Network,
  type NetworkConfiguration,
  type Peer,
  type RPC,
  type ServicePublication,
} from "./index.ts";
import { addressWithPeerId, destinationPeerId } from "./peer.ts";
import {
  createDiscoveryHost,
  discoveryServiceName,
  type DiscoveryNetworkService,
  type DiscoveryUpdate,
} from "./services/discovery.ts";
import { registryServiceName } from "./services/registry.ts";
import { createSignals } from "@v/backend/signals";
import {
  createMessaging,
  type MessagingEvent,
} from "@v/backend/network/services/messaging";
import {
  createDataTransfer,
  dataTransferServiceName,
  type DataSink,
  type DataTransferEvent,
} from "@v/backend/network/services/data-transfer";

interface Echo {
  inspect(value: { payload: Uint8Array }): {
    caller: string;
    nested: { payload: Uint8Array };
  };
}

const networks: Network[] = [];

function rpc<Service extends object>(
  create: (peer: Peer) => Service,
): NetworkServiceFactory {
  return (peer) => ({ remote: create(peer) });
}

type RpcService<Service extends object> = { readonly remote: RPC<Service> };
type DataService = { readonly stream: Data };
type EventService<Event> = { readonly events: Channel<Event> };

function discoveryFactory(
  discovery: ReturnType<typeof createDiscoveryHost>,
): NetworkServiceFactory {
  return (peer) => discovery.service(peer);
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

async function* emptyData(): AsyncGenerator<Uint8Array> {
  // Empty transfers still establish and complete one Data interaction.
}

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
    await expect(peer.remote<RpcService<{ read(): string }>>("echo").remote.read())
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
    const service = firstBeacon.remote<DiscoveryNetworkService>(discoveryServiceName);
    const updates: DiscoveryUpdate[] = [];
    service.events.subscribe((update) => updates.push(update));
    expect(await service.remote.list()).toEqual([]);
    await (await second.network.createPeer(beacon.address)).connect();

    await vi.waitFor(() => expect(updates).toEqual([{
      type: "set",
      peer: {
        peerId: second.network.id,
        addresses: expect.arrayContaining([second.address]),
      },
    }]));
  });
});

describe("per-Peer service instances", () => {
  it("defines RPC as the method-only part of a service", () => {
    expectTypeOf<RPC<{ readonly label: string; read(): string }>>()
      .toEqualTypeOf<{ readonly read: () => string }>();
  });

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
    await expect(allowedRemote.remote<RpcService<{ read(): string }>>("private").remote.read())
      .resolves.toBe("allowed");
    await expect(otherRemote.remote<RpcService<{ read(): string }>>("private").remote.read())
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

    const response = await peer.remote<RpcService<Echo>>("echo").remote.inspect({ payload });

    expect(response.caller).toBe(local.network.id);
    expect([...response.nested.payload]).toEqual([...payload]);
  });

  it("handles a message on the inbound side immediately after connect", async () => {
    let localMessaging!: ReturnType<typeof createMessaging>;
    const localSignals = createSignals();
    const remoteSignals = createSignals();
    const remote = await localNetwork({
      messaging: (peer) => createMessaging(peer, remoteSignals),
    });
    const local = await localNetwork({
      messaging: (peer) => (localMessaging = createMessaging(peer, localSignals)),
    });
    const received: MessagingEvent[] = [];
    remote.network.subscribe((connected, event) => {
      if (event === "connected") {
        connected.service<ReturnType<typeof createMessaging>>("messaging")?.updates
          .subscribe((message) => received.push(message));
      }
    });
    const peer = await (await local.network.createPeer(remote.address)).connect();
    await peer.refreshServices();

    localMessaging.send({ id: "immediate", text: "hello" });

    await vi.waitFor(() => expect(received).toEqual([{
      peerId: local.network.id,
      type: "received",
      message: { id: "immediate", text: "hello" },
    }]));
  });

  it("streams DataTransfer content through its complete service object", async () => {
    let localTransfer!: ReturnType<typeof createDataTransfer>;
    const localSignals = createSignals();
    const remoteSignals = createSignals();
    const remote = await localNetwork({
      [dataTransferServiceName]: (peer) =>
        createDataTransfer(peer, remoteSignals),
    });
    const local = await localNetwork({
      [dataTransferServiceName]: (peer) =>
        (localTransfer = createDataTransfer(peer, localSignals)),
    });
    const received: number[] = [];
    const localEvents: DataTransferEvent[] = [];
    const remoteEvents: DataTransferEvent[] = [];
    const sink: DataSink = {
      async write(data) {
        received.push(...data);
      },
      async close() {},
      async abort() {},
    };
    remote.network.subscribe((connected, event) => {
      if (event !== "connected") return;
      connected.service<ReturnType<typeof createDataTransfer>>(dataTransferServiceName)?.updates
        .subscribe((transfer) => {
          remoteEvents.push(transfer);
          if (transfer.type === "offered") transfer.accept(sink);
        });
    });
    const peer = await (await local.network.createPeer(remote.address)).connect();
    localTransfer.updates.subscribe((event) => localEvents.push(event));
    await peer.refreshServices();

    localTransfer.send({
      id: "network-transfer",
      size: 4,
      metadata: {},
      data: (async function* () {
        yield new Uint8Array([1, 2]);
        yield new Uint8Array([3, 4]);
      })(),
    });

    await vi.waitFor(() => {
      expect(localEvents.at(-1)?.type).toBe("completed");
      expect(remoteEvents.at(-1)?.type).toBe("completed");
    });
    expect(received).toEqual([1, 2, 3, 4]);
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
    const service = peer.remote<RpcService<{ read(): number }>>("changing").remote;

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

  it("delivers ordered events and closes their feed when publication changes", async () => {
    const instances = new Map<string, {
      readonly events: Channel<number>;
      readonly subscribed: Promise<void>;
      readonly stopped: ReturnType<typeof vi.fn>;
    }>();
    const updates: NetworkServiceFactory = (peer) => {
      const channel = createChannel<number>();
      let observed!: () => void;
      const subscribed = new Promise<void>((resolve) => {
        observed = resolve;
      });
      const stopped = vi.fn();
      const events: Channel<number> = {
        publish: channel.publish,
        subscribe(listener) {
          observed();
          const stop = channel.subscribe(listener);
          return () => {
            stop();
            stopped();
          };
        },
      };
      instances.set(peer.id, { events, subscribed, stopped });
      return { events };
    };
    const remote = await localNetwork({ updates });
    const local = await localNetwork();
    const peer = await (await local.network.createPeer(remote.address)).connect();
    await peer.refreshServices();
    await vi.waitFor(() => expect(remote.network.connectedPeers()).toHaveLength(1));
    const inbound = remote.network.connectedPeers()[0];
    const first = instances.get(local.network.id);
    if (inbound === undefined || first === undefined) throw new Error("Missing event service.");
    const received: number[] = [];
    peer.remote<EventService<number>>("updates").events.subscribe((event) => {
      received.push(event);
    });
    await first.subscribed;

    first.events.publish(1);
    first.events.publish(2);
    await vi.waitFor(() => expect(received).toEqual([1, 2]));

    remote.network.publish(inbound, "updates", false);
    await vi.waitFor(() => expect(first.stopped).toHaveBeenCalledOnce());
    first.events.publish(3);
    expect(received).toEqual([1, 2]);
    await peer.refreshServices();

    remote.network.publish(inbound, "updates", true);
    await peer.refreshServices();
    const restored = instances.get(local.network.id);
    if (restored === undefined) throw new Error("Missing restored event service.");
    expect(restored).not.toBe(first);
    await restored.subscribed;
    restored.events.publish(4);
    await vi.waitFor(() => expect(received).toEqual([1, 2, 4]));

    await remote.network.close();
    await vi.waitFor(() => expect(restored.stopped).toHaveBeenCalledOnce());
  });

  it("keeps an accepted stream alive while rejecting new streams after removal", async () => {
    const received: number[] = [];
    let accepted!: () => void;
    const firstAccepted = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    let stopped!: () => void;
    const receiverStopped = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    const bytes: NetworkServiceFactory = () => {
      const stream = createData();
      void (async () => {
        try {
          while (true) {
            const source = await stream.accept();
            accepted();
            for await (const chunk of source) received.push(...chunk);
          }
        } catch {
          stopped();
        }
      })();
      return { stream };
    };
    const remote = await localNetwork({ bytes });
    const local = await localNetwork();
    const peer = await (await local.network.createPeer(remote.address)).connect();
    await peer.refreshServices();
    await vi.waitFor(() => expect(remote.network.connectedPeers()).toHaveLength(1));
    const inbound = remote.network.connectedPeers()[0];
    if (inbound === undefined) throw new Error("Remote did not retain the connected Peer.");
    let finish!: () => void;
    const remaining = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const sending = peer.remote<DataService>("bytes").stream.send((async function* () {
      yield new Uint8Array([1]);
      await remaining;
      yield new Uint8Array([2, 3]);
    })());
    await firstAccepted;

    remote.network.publish(inbound, "bytes", false);
    await peer.refreshServices();
    finish();
    await sending;
    await receiverStopped;
    expect(received).toEqual([1, 2, 3]);
    await expect(peer.remote<DataService>("bytes").stream.send(emptyData()))
      .rejects.toThrow("does not provide");

    remote.network.publish(inbound, "bytes", true);
    await peer.refreshServices();
    await peer.remote<DataService>("bytes").stream.send((async function* () {
      yield new Uint8Array([4]);
    })());
    expect(received).toEqual([1, 2, 3, 4]);
  });

  it("validates fixed service factories", async () => {
    await expect(localNetwork({
      invalid: {} as NetworkServiceFactory,
    })).rejects.toThrow("must be a function");
    const empty = await localNetwork({
      invalid: (() => ({})) as unknown as NetworkServiceFactory,
    });
    const emptyConsumer = await localNetwork();
    const emptyPeer = await (await emptyConsumer.network.createPeer(empty.address)).connect();
    await vi.waitFor(() => expect(emptyPeer.isConnected()).toBe(false));

    const malformed = await localNetwork({
      invalid: (() => ({ events: { publish() {} } })) as unknown as NetworkServiceFactory,
    });
    const malformedConsumer = await localNetwork();
    const malformedPeer = await (
      await malformedConsumer.network.createPeer(malformed.address)
    ).connect();
    await vi.waitFor(() => expect(malformedPeer.isConnected()).toBe(false));
  });

  it("accepts every non-empty combination of service facets", async () => {
    const remoteFacet = () => ({ read: () => "ready" });
    const eventFacet = () => createChannel<number>();
    const dataFacet = () => createData();
    const remote = await localNetwork({
      remote: () => ({ remote: remoteFacet() }),
      events: () => ({ events: eventFacet() }),
      stream: () => ({ stream: dataFacet() }),
      remoteEvents: () => ({ remote: remoteFacet(), events: eventFacet() }),
      remoteStream: () => ({ remote: remoteFacet(), stream: dataFacet() }),
      eventsStream: () => ({ events: eventFacet(), stream: dataFacet() }),
      all: () => ({ remote: remoteFacet(), events: eventFacet(), stream: dataFacet() }),
    });
    const local = await localNetwork();
    const peer = await (await local.network.createPeer(remote.address)).connect();

    await expect(peer.refreshServices()).resolves.toEqual([
      registryServiceName,
      "remote",
      "events",
      "stream",
      "remoteEvents",
      "remoteStream",
      "eventsStream",
      "all",
    ]);
  });

  it("does not call service factories before a Peer connects", async () => {
    const create = vi.fn(() => ({ remote: { read: () => "ready" } }));
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
