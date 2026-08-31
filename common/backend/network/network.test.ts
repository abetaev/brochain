// @vitest-environment node

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { identify, identifyPush } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import signals, { type Channel } from "../signals.ts";
import createNetwork, {
  createStream,
  type Methods,
  type Stream,
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
  type DiscoveryService,
  type DiscoveryUpdate,
} from "./services/discovery.ts";
import { registryServiceName } from "./services/registry.ts";

type Echo = {
  inspect(value: { payload: readonly number[] }): {
    caller: string;
    nested: { payload: readonly number[] };
  };
};

const networks: Network[] = [];

function rpc<Service extends Methods>(
  create: (peer: Peer) => Service,
): NetworkServiceFactory {
  return (peer) => ({ remote: create(peer) });
}

type RpcService<Service extends object> = { readonly remote: RPC<Service> };
type DataService = { readonly data: Stream };
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
    remote.network.updates.subscribe((update) => {
      if (update.type === "connected") inbound(update.peer);
    });
    local.network.updates.subscribe((update) => {
      events.push(update.type);
      if (update.type === "connected") {
        expect(update.peer.isConnected()).toBe(true);
        expect(update.peer.services()).toEqual([]);
      }
    });

    const peer = await (await local.network.createPeer(remote.address)).connect();

    expect(events).toEqual(["connected"]);
    await vi.waitFor(() => expect(inbound).toHaveBeenCalledOnce());
    expect(createdFor).toEqual([local.network.id]);
    await peer.refreshServices();
    expect(peer.services()).toEqual([registryServiceName, "echo"]);
    await expect(peer.service<RpcService<{ read(): string }>>("echo").remote.read())
      .resolves.toBe(local.network.id);
  });

  it("terminates a connected Peer when its first Registry request fails", async () => {
    const remote = await localNetwork(
      {},
      (_peer, serviceName) => serviceName !== registryServiceName,
    );
    const local = await localNetwork();
    const events: string[] = [];
    local.network.updates.subscribe(({ type }) => events.push(type));

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
    local.network.updates.subscribe(({ type }) => events.push(type));

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
    beacon.network.updates.subscribe(discovery.peerChanged);
    const first = await localNetwork();
    const second = await localNetwork();
    const firstBeacon = await (await first.network.createPeer(beacon.address)).connect();
    await firstBeacon.refreshServices();
    const service = firstBeacon.service<DiscoveryService>(discoveryServiceName);
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
  it("promises the method-only part of a service", () => {
    expectTypeOf<RPC<{ readonly label: string; read(): string }>>()
      .toEqualTypeOf<{ readonly read: () => Promise<string> }>();
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
    await expect(allowedRemote.service<RpcService<{ read(): string }>>("private").remote.read())
      .resolves.toBe("allowed");
    await expect(otherRemote.service<RpcService<{ read(): string }>>("private").remote.read())
      .rejects.toThrow("Method not found");
  });

  it("routes authenticated RPC method objects and nested values", async () => {
    const remote = await localNetwork({
      echo: rpc((peer): Echo => ({
        inspect: ({ payload }) => ({ caller: peer.id, nested: { payload } }),
      })),
    });
    const local = await localNetwork();
    const peer = await (await local.network.createPeer(remote.address)).connect();
    await peer.refreshServices();
    const payload = [0, 1, 127, 255];

    const response = await peer.service<RpcService<Echo>>("echo").remote.inspect({ payload });

    expect(response.caller).toBe(local.network.id);
    expect(response.nested.payload).toEqual(payload);
    await expect(peer.service<RpcService<{ inspect(value: unknown): unknown }>>("echo")
      .remote.inspect({ payload: new Uint8Array([1]) }))
      .rejects.toThrow("JSON-compatible values");
  });

  it("dispatches an inbound call to the instance created at connection time", async () => {
    const notify = () => {
      const events = signals.channel<string>();
      return { remote: { send: (text: string) => events.publish(text) }, events };
    };
    const remote = await localNetwork({ notify });
    const local = await localNetwork({ notify });
    const received: string[] = [];
    remote.network.updates.subscribe((update) => {
      if (update.type !== "connected") return;
      update.peer.service<EventService<string>>("notify").events.subscribe((text) => {
        received.push(text);
      });
    });
    const peer = await (await local.network.createPeer(remote.address)).connect();
    await peer.refreshServices();

    await peer.service<RpcService<{ send(text: string): void }>>("notify")
      .remote.send("immediate");

    expect(received).toEqual(["immediate"]);
  });

  it("publishes and removes one service dynamically, announced without a refresh", async () => {
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
    const service = peer.service<RpcService<{ read(): number }>>("changing").remote;

    await expect(service.read()).resolves.toBe(1);
    const events: string[] = [];
    local.network.updates.subscribe(({ type }) => events.push(type));

    remote.network.publish(inbound, "changing", false);
    expect(remote.network.services()).toEqual(["registry", "changing"]);
    await vi.waitFor(() => expect(peer.services()).toEqual([registryServiceName]));
    expect(events).toEqual(["services"]);
    await expect(service.read()).rejects.toThrow("Method not found");

    remote.network.publish(inbound, "changing", true);
    await vi.waitFor(() =>
      expect(peer.services()).toEqual([registryServiceName, "changing"])
    );
    await expect(service.read()).resolves.toBe(2);
  });

  it("delivers ordered events and closes their feed when publication changes", async () => {
    const instances = new Map<string, {
      readonly events: Channel<number>;
      readonly subscribed: Promise<void>;
      readonly stopped: ReturnType<typeof vi.fn>;
    }>();
    const updates: NetworkServiceFactory = (peer) => {
      const channel = signals.channel<number>();
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
    peer.service<EventService<number>>("updates").events.subscribe((event) => {
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
      const data = createStream();
      void (async () => {
        try {
          while (true) {
            const transfer = await data.accept();
            accepted();
            for await (const chunk of transfer.data()) received.push(...chunk);
          }
        } catch {
          stopped();
        }
      })();
      return { data };
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
    const sending = peer.service<DataService>("bytes").data.send((async function* () {
      yield new Uint8Array([1]);
      await remaining;
      yield new Uint8Array([2, 3]);
    })()).completion;
    await firstAccepted;

    remote.network.publish(inbound, "bytes", false);
    await peer.refreshServices();
    finish();
    await sending;
    await receiverStopped;
    expect(received).toEqual([1, 2, 3]);
    await expect(peer.service<DataService>("bytes").data.send(emptyData()).completion)
      .rejects.toThrow("not available to the peer");

    remote.network.publish(inbound, "bytes", true);
    await peer.refreshServices();
    await peer.service<DataService>("bytes").data.send((async function* () {
      yield new Uint8Array([4]);
    })()).completion;
    expect(received).toEqual([1, 2, 3, 4]);
  });

  it("accepts every non-empty combination of service facets", async () => {
    const remoteFacet = () => ({ read: () => "ready" });
    const eventFacet = () => signals.channel<number>();
    const dataFacet = () => createStream();
    const remote = await localNetwork({
      remote: () => ({ remote: remoteFacet() }),
      events: () => ({ events: eventFacet() }),
      data: () => ({ data: dataFacet() }),
      remoteEvents: () => ({ remote: remoteFacet(), events: eventFacet() }),
      remoteData: () => ({ remote: remoteFacet(), data: dataFacet() }),
      eventsData: () => ({ events: eventFacet(), data: dataFacet() }),
      all: () => ({ remote: remoteFacet(), events: eventFacet(), data: dataFacet() }),
    });
    const local = await localNetwork();
    const peer = await (await local.network.createPeer(remote.address)).connect();

    await expect(peer.refreshServices()).resolves.toEqual([
      registryServiceName,
      "remote",
      "events",
      "data",
      "remoteEvents",
      "remoteData",
      "eventsData",
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
