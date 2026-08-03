import { strict as assert } from "node:assert";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayServer, circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p } from "libp2p";

const protocol = "/brochain/integration/1.0.0";
const relayPort = Number.parseInt(process.env.NETWORK_TEST_RELAY_PORT ?? "19090", 10);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function createPeer() {
  return createLibp2p({
    addresses: {
      listen: ["/p2p-circuit", "/webrtc"],
    },
    transports: [webSockets(), webRTC(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: {
      denyDialMultiaddr: () => false,
    },
    services: {
      identify: identify(),
    },
  });
}

async function waitForWebRtcAddress(peer) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const address = peer.getMultiaddrs().map((value) => value.toString()).find((value) => value.includes("/webrtc"));

    if (address !== undefined) {
      return address;
    }

    await delay(100);
  }

  throw new Error("The peer did not receive a WebRTC relay address.");
}

const relay = await createLibp2p({
  addresses: {
    listen: [`/ip4/0.0.0.0/tcp/${relayPort}/ws`],
    announce: [`/dns4/localhost/tcp/${relayPort}/ws`],
  },
  transports: [webSockets()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  connectionGater: {
    denyDialMultiaddr: () => false,
  },
  services: {
    identify: identify(),
    relay: circuitRelayServer(),
  },
});
const relayAddress = relay.getMultiaddrs().map((address) => address.toString()).find((address) => address.includes("/ws"));

if (relayAddress === undefined) {
  await relay.stop();
  throw new Error("The relay did not expose a WebSocket address.");
}

const listener = await createPeer();
const dialer = await createPeer();

try {
  const received = new Promise((resolve) => {
    void listener.handle(protocol, async (stream) => {
      let message = "";

      for await (const chunk of stream) {
        message += decoder.decode(chunk instanceof Uint8Array ? chunk : chunk.subarray(), { stream: true });
      }

      resolve(message);
      await stream.close();
    });
  });

  await listener.dial(multiaddr(relayAddress));
  await dialer.dial(multiaddr(relayAddress));
  const listenerAddress = await waitForWebRtcAddress(listener);
  const stream = await dialer.dialProtocol(multiaddr(listenerAddress), protocol);
  stream.send(encoder.encode("hello through WebRTC"));
  await stream.close();

  assert.equal(await received, "hello through WebRTC");
  assert.ok(dialer.getConnections(listener.peerId).some((connection) => connection.direct));
  console.info("Relay-backed WebRTC integration passed.");
} finally {
  await dialer.stop();
  await listener.stop();
  await relay.stop();
}
