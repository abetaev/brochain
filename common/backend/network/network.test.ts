// @vitest-environment node

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { identify, identifyPush } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { afterEach, describe, expect, it, vi } from "vitest";
import createNetwork, {
  type Network,
  type NetworkConfiguration,
  type Peer,
  type Services,
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
  services: Services = {},
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
  }, services);
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

  it("coalesces concurrent identity-less construction around one Peer", async () => {
    const remote = await localNetwork();
    const local = await localNetwork();
    const addressWithoutPeerId = remote.address.replace(/\/p2p\/[^/]+$/, "");

    const [first, second] = await Promise.all([
      local.network.createPeer(addressWithoutPeerId),
      local.network.createPeer(addressWithoutPeerId),
    ]);

    expect(second).toBe(first);
    expect(first.id).toBe(remote.network.id);
    expect(first.addresses()).toContain(remote.address);
    expect(first.isConnected()).toBe(true);
    expect(local.network.connectedPeers()).toEqual([first]);
  });

  it("coalesces concurrent known-identity dials around one active Peer", async () => {
    const remote = await localNetwork();
    const local = await localNetwork();
    const first = await local.network.createPeer(remote.address);
    const second = await local.network.createPeer(remote.address);

    const [firstActive, secondActive] = await Promise.all([
      first.connect(),
      second.connect(),
    ]);

    expect(firstActive).toBe(first);
    expect(secondActive).toBe(first);
    expect(local.network.connectedPeers()).toEqual([first]);
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
    const identity = await generateKeyPair("Ed25519");
    const local = await localNetwork({}, true, identity);
    const duplicate = await localNetwork({}, true, identity);
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

    const duplicatePeer = await duplicate.network.createPeer(remote.address);
    await duplicatePeer.connect();
    await vi.waitFor(() => expect(remote.network.connectedPeers()).toHaveLength(1));
    expect(remoteEvents).toEqual([`${local.network.id}:connected`]);

    await local.network.close();
    await vi.waitFor(() => expect(remote.network.connectedPeers()).toHaveLength(1));
    expect(remoteEvents).toEqual([`${local.network.id}:connected`]);

    unsubscribe();
    await duplicate.network.close();
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

  it("learns inbound addresses from Identify through the public Peer projection", async () => {
    const inboundEvents: string[] = [];
    const remote = await localNetwork();
    remote.network.subscribe((peer, event) => {
      if (event === "connected") {
        inboundEvents.push(event);
        peer.subscribe((next) => inboundEvents.push(next));
      }
    });
    const local = await localNetwork();
    const peer = await local.network.createPeer(remote.address);

    await peer.connect();
    await vi.waitFor(() => {
      const inbound = remote.network.connectedPeers()
        .find(({ id }) => id === local.network.id);
      expect(inbound?.addresses()).toContain(local.address);
    });

    const inbound = remote.network.connectedPeers()
      .find(({ id }) => id === local.network.id);
    expect(inbound?.addresses()).toContain(local.address);
    expect(inboundEvents).toEqual(["connected"]);
  });

  it("keeps inbound peers valid but undiscoverable until they advertise an address", async () => {
    const beacon = await localNetwork({
      [discoveryServiceName]: {
        rpc: (requester, network) => createDiscovery(
          requester,
          network.connectedPeers,
        ),
      },
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
    const remote = await localNetwork({
      echo: {
        rpc: (peer): Echo => {
          remotePeers.set(peer.id, peer);
          return {
            inspect: ({ payload }) => ({
              caller: peer.id,
              nested: { payload },
            }),
          };
        },
      },
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
    let privateEnabled = true;
    const remote = await localNetwork({
      audience: { rpc: (peer) => ({ identify: () => peer.id }) },
      private: {
        enabled: (peer) => privateEnabled && peer.id === authorized.network.id,
        rpc: () => ({ read: () => "allowed" }),
      },
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
    const privateService = authorizedRemote.service<{ read(): string }>("private");
    await expect(privateService.read()).resolves.toBe("allowed");

    privateEnabled = false;
    expect(await authorizedRemote.service<Registry>(registryServiceName).list())
      .toEqual([registryServiceName, "audience"]);
    await expect(privateService.read()).rejects.toThrow();
    expect(remote.network.services()).toEqual({
      registry: expect.any(Object),
      audience: expect.any(Object),
      private: expect.any(Object),
    });

    privateEnabled = true;
    expect(await authorizedRemote.service<Registry>(registryServiceName).list())
      .toEqual([registryServiceName, "audience", "private"]);
    await expect(privateService.read()).resolves.toBe("allowed");

    await remote.network.provide({
      later: { rpc: () => ({ read: () => "live" }) },
    });
    expect(await otherRemote.service<Registry>(registryServiceName).list())
      .toEqual([registryServiceName, "audience", "later"]);
  });

  it("validates service definitions and rejects duplicate service names", async () => {
    const remote = await localNetwork();
    await remote.network.provide({ echo: { rpc: () => ({ read: () => "local" }) } });
    await expect(remote.network.provide({
      echo: { rpc: () => ({ read: () => "duplicate" }) },
    })).rejects.toThrow("already provided");
    await expect(remote.network.provide({
      [registryServiceName]: { rpc: () => ({ list: () => [] }) },
    })).rejects.toThrow("already provided");
    await expect(remote.network.provide({
      "": { rpc: () => ({ read: () => "unnamed" }) },
    })).rejects.toThrow("must have a name");
    await expect(remote.network.provide({ empty: {} }))
      .rejects.toThrow("must provide RPC or a protocol");
  });

  it("provides a service to Peers created before registration", async () => {
    let inbound: Peer | undefined;
    const remote = await localNetwork();
    remote.network.subscribe((peer, event) => {
      if (event === "connected") inbound = peer;
    });
    const local = await localNetwork();
    const peer = await local.network.createPeer(remote.address);
    await local.network.provide({
      callback: { rpc: () => ({ read: () => "candidate" }) },
    });

    const active = await peer.connect();
    expect(active).toBe(peer);
    await vi.waitFor(() => expect(inbound).toBeDefined());
    await expect(inbound!.service<{ read(): string }>("callback").read())
      .resolves.toBe("candidate");
    expect(local.network.services()).toEqual({
      registry: expect.any(Object),
      callback: expect.any(Object),
    });
  });
});

describe("byte-stream protocols", () => {
  it("checks new streams dynamically while accepted streams finish", async () => {
    const protocol = "/brochain/test-bytes/1.0.0";
    let enabled = true;
    let accepted!: () => void;
    const firstAccepted = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const remote = await localNetwork();
    await remote.network.provide({
      bytes: {
        enabled: () => enabled,
        protocols: [{
          id: protocol,
          maxInboundStreams: 2,
          maxOutboundStreams: 2,
          async accept(_peer, stream) {
            accepted();
            for await (const bytes of stream) await stream.write(bytes);
            await stream.close();
          },
        }],
      },
    });
    const local = await localNetwork();
    const peer = await local.network.createPeer(remote.address);
    await peer.connect();

    expect(await peer.service<Registry>(registryServiceName).list())
      .toEqual([registryServiceName, "bytes"]);
    const stream = await peer.open(protocol);
    await firstAccepted;
    enabled = false;
    expect(await peer.service<Registry>(registryServiceName).list())
      .toEqual([registryServiceName]);
    expect(remote.network.services()).toEqual({
      registry: expect.any(Object),
      bytes: expect.any(Object),
    });

    await stream.write(new Uint8Array([1, 2]));
    await stream.write(new Uint8Array([3, 4]));
    await stream.close();
    const received: number[] = [];
    for await (const bytes of stream) received.push(...bytes);
    expect(received).toEqual([1, 2, 3, 4]);

    await expect((async () => {
      const rejected = await peer.open(protocol);
      await rejected.write(new Uint8Array([5]));
      await rejected.close();
      for await (const _bytes of rejected) {
        // The disabled remote aborts without returning data.
      }
    })()).rejects.toThrow();

    enabled = true;
    expect(await peer.service<Registry>(registryServiceName).list())
      .toEqual([registryServiceName, "bytes"]);
    const restored = await peer.open(protocol);
    await restored.write(new Uint8Array([6]));
    await restored.close();
    const restoredBytes: number[] = [];
    for await (const bytes of restored) restoredBytes.push(...bytes);
    expect(restoredBytes).toEqual([6]);
  });

  it("rejects duplicate protocols and invalid stream limits", async () => {
    const network = await localNetwork();
    const protocol = {
      id: "/brochain/duplicate/1.0.0",
      accept: async () => {},
    };
    await network.network.provide({ first: { protocols: [protocol] } });
    await expect(network.network.provide({ second: { protocols: [protocol] } }))
      .rejects.toThrow("already provided");
    await expect(network.network.provide({
      invalid: { protocols: [{ ...protocol, id: "/invalid", maxInboundStreams: 0 }] },
    })).rejects.toThrow("positive integer");
  });
});
