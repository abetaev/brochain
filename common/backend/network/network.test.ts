// @vitest-environment node

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify, identifyPush } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p } from "libp2p";
import { afterEach, describe, expect, it, vi } from "vitest";
import createNetwork, {
  type InitializePeer,
  type Network,
  type Peer,
} from "./index.ts";
import { addressWithPeerId, destinationPeerId } from "./peer.ts";
import {
  createDiscovery,
  discoveryServiceName,
  type Discovery,
} from "./services/discovery.ts";
import {
  registryServiceName,
  type Registry,
} from "./services/registry.ts";

interface Echo {
  inspect(value: { payload: Uint8Array }): {
    caller: string;
    nested: { payload: Uint8Array };
  };
}

const networks: Network[] = [];

async function localNetwork(
  initializePeer?: InitializePeer,
  identifyPeers = true,
) {
  const node = await createLibp2p({
    start: false,
    addresses: { listen: ["/ip4/127.0.0.1/tcp/0/ws"] },
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: identifyPeers
      ? { identify: identify(), identifyPush: identifyPush() }
      : undefined,
  });
  const network = await createNetwork(node, initializePeer);
  networks.push(network);
  const address = node.getMultiaddrs()[0]?.toString();
  if (address === undefined) throw new Error("Test peer did not expose an address.");
  return { network, address, node };
}

function addressedPeer(address: string): string | undefined {
  return multiaddr(address).getComponents()
    .filter(({ name }) => name === "p2p")
    .at(-1)?.value;
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

  it("constructs independent disconnected Peers and merges addresses only into an active Peer", async () => {
    const remote = await localNetwork();
    const other = await localNetwork();
    const local = await localNetwork();
    const alternate = remote.address.replace("/ip4/127.0.0.1", "/dns4/localhost");

    const first = await local.network.createPeer(remote.address, alternate);
    const second = await local.network.createPeer(alternate);
    expect(first).not.toBe(second);
    expect(first.addresses()).toEqual([remote.address, alternate]);
    expect(second.addresses()).toEqual([alternate]);
    expect(local.network.connectedPeers()).toEqual([]);

    expect(await first.connect()).toBe(first);
    expect(await second.connect()).toBe(first);
    expect(second.isConnected()).toBe(false);
    await expect(second.service<Registry>(registryServiceName).list())
      .rejects.toThrow("not connected");
    expect(await local.network.createPeer(alternate)).toBe(first);
    expect(local.network.connectedPeers()).toEqual([first]);

    await expect(local.network.createPeer(local.address)).rejects.toThrow("local peer");
    await expect(
      local.network.createPeer(remote.address, other.address),
    ).rejects.toThrow("different peers");
  });

  it("authenticates concurrent identity-less construction once", async () => {
    const remote = await localNetwork();
    const local = await localNetwork();
    const addressWithoutPeerId = remote.address.replace(/\/p2p\/[^/]+$/, "");
    let connections = 0;
    remote.node.addEventListener("connection:open", () => {
      connections += 1;
    });

    const [first, second] = await Promise.all([
      local.network.createPeer(addressWithoutPeerId),
      local.network.createPeer(addressWithoutPeerId),
    ]);

    expect(second).toBe(first);
    expect(first.id).toBe(remote.network.id);
    expect(first.addresses()).toContain(remote.address);
    expect(first.isConnected()).toBe(true);
    expect(local.network.connectedPeers()).toEqual([first]);
    await vi.waitFor(() => expect(connections).toBe(1));
  });

  it("coalesces concurrent known-identity dials around one active Peer", async () => {
    const remote = await localNetwork();
    const local = await localNetwork();
    const first = await local.network.createPeer(remote.address);
    const second = await local.network.createPeer(remote.address);
    let connections = 0;
    remote.node.addEventListener("connection:open", () => {
      connections += 1;
    });

    const [firstActive, secondActive] = await Promise.all([
      first.connect(),
      second.connect(),
    ]);

    expect(firstActive).toBe(first);
    expect(secondActive).toBe(first);
    expect(local.network.connectedPeers()).toEqual([first]);
    await vi.waitFor(() => expect(connections).toBe(1));
  });

  it("emits Peer connection transitions and removes the final disconnected Peer", async () => {
    const remote = await localNetwork();
    const local = await localNetwork();
    const peer = await local.network.createPeer(remote.address);
    const events: string[] = [];
    peer.subscribe((event) => events.push(event));

    expect(await peer.connect()).toBe(peer);
    expect(events).toEqual(["connected"]);

    await remote.network.close();
    await vi.waitFor(() => expect(peer.isConnected()).toBe(false));
    expect(events).toEqual(["connected", "disconnected"]);
    expect(local.network.connectedPeers()).toEqual([]);
  });

  it("publishes active topology once for inbound connection and final disconnection", async () => {
    const remote = await localNetwork();
    const local = await localNetwork();
    const remoteEvents: string[] = [];
    const removedEvents: string[] = [];
    const localEvents: string[] = [];
    remote.network.subscribe((peer, event) => remoteEvents.push(`${peer.id}:${event}`));
    const unsubscribe = remote.network.subscribe((peer, event) => {
      removedEvents.push(`${peer.id}:${event}`);
    });
    local.network.subscribe((peer, event) => localEvents.push(`${peer.id}:${event}`));
    const peer = await local.network.createPeer(remote.address);

    await peer.connect();
    await vi.waitFor(() => {
      const inbound = remote.network.connectedPeers()
        .find(({ id }) => id === local.network.id);
      expect(inbound?.addresses()).toContain(local.address);
    });
    expect(remoteEvents).toEqual([`${local.network.id}:connected`]);
    expect(removedEvents).toEqual([`${local.network.id}:connected`]);
    expect(localEvents).toEqual([`${remote.network.id}:connected`]);

    const extra = await local.node.dial(multiaddr(remote.address), { force: true });
    await vi.waitFor(() => expect(remote.node.getConnections().filter((connection) =>
      connection.remotePeer.toString() === local.network.id
    )).toHaveLength(2));
    expect(remoteEvents).toEqual([`${local.network.id}:connected`]);

    await extra.close();
    await vi.waitFor(() => expect(remote.node.getConnections().filter((connection) =>
      connection.remotePeer.toString() === local.network.id
    )).toHaveLength(1));
    expect(remoteEvents).toEqual([`${local.network.id}:connected`]);

    unsubscribe();
    await local.network.close();
    await vi.waitFor(() => expect(remoteEvents).toEqual([
      `${local.network.id}:connected`,
      `${local.network.id}:disconnected`,
    ]));
    expect(removedEvents).toEqual([`${local.network.id}:connected`]);
    expect(localEvents).toEqual([
      `${remote.network.id}:connected`,
      `${remote.network.id}:disconnected`,
    ]);
    expect(remote.network.connectedPeers()).toEqual([]);
  });

  it("learns inbound addresses from Identify without retaining the transport source address", async () => {
    const inboundEvents: string[] = [];
    const remote = await localNetwork((peer) => {
      peer.subscribe((event) => inboundEvents.push(event));
    });
    const local = await localNetwork();
    let inboundSource: string | undefined;
    remote.node.addEventListener("connection:open", (event) => {
      inboundSource = event.detail.remoteAddr.toString();
    });
    const peer = await local.network.createPeer(remote.address);

    await peer.connect();
    await vi.waitFor(() => {
      const inbound = remote.network.connectedPeers()
        .find(({ id }) => id === local.network.id);
      expect(inbound?.addresses()).toContain(local.address);
    });

    const source = inboundSource;
    if (source === undefined) throw new Error("The inbound connection did not expose its source.");
    const sourceWithId = addressedPeer(source) === local.network.id
      ? multiaddr(source).toString()
      : multiaddr(source).encapsulate(`/p2p/${local.network.id}`).toString();
    const inbound = remote.network.connectedPeers()
      .find(({ id }) => id === local.network.id);
    expect(inbound?.addresses()).not.toContain(sourceWithId);
    expect(inboundEvents).toEqual(["connected"]);
  });

  it("keeps inbound peers valid but undiscoverable until they advertise an address", async () => {
    const beacon = await localNetwork((requester, network) => {
      requester.host(
        discoveryServiceName,
        createDiscovery(requester, network.connectedPeers),
      );
    }, false);
    const first = await localNetwork(undefined, false);
    const second = await localNetwork(undefined, false);
    const firstBeacon = await first.network.createPeer(beacon.address);
    const secondBeacon = await second.network.createPeer(beacon.address);

    await Promise.all([firstBeacon.connect(), secondBeacon.connect()]);
    await vi.waitFor(() => expect(beacon.network.connectedPeers()).toHaveLength(2));
    expect(beacon.network.connectedPeers().every((peer) =>
      peer.isConnected() && peer.addresses().length === 0
    )).toBe(true);
    expect(await firstBeacon.service<Discovery>(discoveryServiceName).list()).toEqual([]);
  });
});

describe("per-Peer RPC services", () => {
  it("hosts mandatory Registry and routes authenticated plain method objects with bytes", async () => {
    const remotePeers = new Map<string, Peer>();
    const remote = await localNetwork((peer) => {
      remotePeers.set(peer.id, peer);
      peer.host<Echo>("echo", {
        inspect: ({ payload }) => ({
          caller: peer.id,
          nested: { payload },
        }),
      });
    });
    const local = await localNetwork();
    const peer = await local.network.createPeer(remote.address);
    await peer.connect();

    expect(await peer.service<Registry>(registryServiceName).list())
      .toEqual([registryServiceName, "echo"]);
    const payload = new Uint8Array([0, 1, 127, 255]);
    const response = await peer.service<Echo>("echo").inspect({ payload });
    expect(response.caller).toBe(local.network.id);
    expect([...response.nested.payload]).toEqual([...payload]);
    expect(remotePeers.get(local.network.id)?.isConnected()).toBe(true);
    await expect(
      (peer.service<Echo>("echo") as unknown as { toString(): Promise<string> }).toString(),
    ).rejects.toThrow("Invalid RPC method");
  });

  it("initializes and authorizes services independently for each Peer", async () => {
    const authorized = await localNetwork();
    const remotePeers = new Map<string, Peer>();
    const remote = await localNetwork((peer) => {
      remotePeers.set(peer.id, peer);
      peer.host("audience", { identify: () => peer.id });
      if (peer.id === authorized.network.id) {
        peer.host("private", { read: () => "allowed" });
      }
    });
    const other = await localNetwork();
    const authorizedRemote = await authorized.network.createPeer(remote.address);
    const otherRemote = await other.network.createPeer(remote.address);
    await Promise.all([authorizedRemote.connect(), otherRemote.connect()]);

    expect(await authorizedRemote.service<{ identify(): string }>("audience").identify())
      .toBe(authorized.network.id);
    expect(await otherRemote.service<{ identify(): string }>("audience").identify())
      .toBe(other.network.id);
    expect(await authorizedRemote.service<Registry>(registryServiceName).list())
      .toEqual([registryServiceName, "audience", "private"]);
    expect(await otherRemote.service<Registry>(registryServiceName).list())
      .toEqual([registryServiceName, "audience"]);

    remotePeers.get(other.network.id)?.host("later", { read: () => "live" });
    expect(await otherRemote.service<Registry>(registryServiceName).list())
      .toEqual([registryServiceName, "audience", "later"]);
  });

  it("validates hosted method objects and rejects duplicate service names", async () => {
    const remote = await localNetwork();
    const local = await localNetwork();
    const peer = await local.network.createPeer(remote.address);

    peer.host("echo", { read: () => "local" });
    expect(() => peer.host("echo", { read: () => "duplicate" })).toThrow("already hosted");
    expect(() => peer.host(registryServiceName, { list: () => [] })).toThrow("already hosted");
    expect(() => peer.host("", { read: () => "unnamed" })).toThrow("must have a name");
    expect(() => peer.host("stateful", { value: 1 })).toThrow("only methods");
  });

  it("preserves services hosted on the outbound candidate adopted by connection open", async () => {
    let inbound: Peer | undefined;
    const remote = await localNetwork((peer) => {
      inbound = peer;
    });
    const local = await localNetwork();
    const peer = await local.network.createPeer(remote.address);
    peer.host("callback", { read: () => "candidate" });

    const active = await peer.connect();
    expect(active).toBe(peer);
    await vi.waitFor(() => expect(inbound).toBeDefined());
    await expect(inbound!.service<{ read(): string }>("callback").read())
      .resolves.toBe("candidate");
  });
});
