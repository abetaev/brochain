import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { identify, identifyPush } from "@libp2p/identify";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { createLibp2p } from "libp2p";
import { base64ToBytes } from "../common/base64.ts";
import { createNetwork, type Network, type Registry } from "../common/network.ts";
import { createIdentity } from "@/services/identity";
import { createMessaging } from "@/services/messaging";
import { createStorage } from "@/storage";

export interface Session {
  readonly username: string;
  readonly network: Network;
  readonly registry: Registry;
  readonly identity: ReturnType<typeof createIdentity>;
  readonly messaging: ReturnType<typeof createMessaging>;
  close(): Promise<void>;
}

interface ActiveIdentity {
  readonly username: string;
  readonly identitySeed: string;
}

const relayReservationTimeout = 5_000;

export async function createSession(
  activeIdentity: () => Promise<ActiveIdentity | undefined>,
  closeAccountSession: () => Promise<void>,
): Promise<Session> {
  const identity = await activeIdentity();
  if (identity === undefined) throw new Error("The account is not unlocked.");

  const privateKey = await generateKeyPairFromSeed(
    "Ed25519",
    base64ToBytes(identity.identitySeed),
  );
  const node = await createLibp2p({
    start: false,
    privateKey,
    addresses: { listen: ["/p2p-circuit", "/webrtc"] },
    transports: [
      webSockets(),
      webRTC(),
      circuitRelayTransport({ reservationCompletionTimeout: relayReservationTimeout }),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: { denyDialMultiaddr: () => false },
    services: {
      identify: identify(),
      identifyPush: identifyPush({ debounce: 0 }),
    },
  });

  try {
    const { network, registry } = await createNetwork(
      node,
      [defaultBeaconAddress()],
      async (signal) => await waitForWebRtcAddress(node, signal),
    );
    const storage = createStorage();
    const peerIdentity = createIdentity(identity.username, storage);
    const messaging = createMessaging(storage);
    network.host((peer) => peerIdentity.serve(peer));
    network.host((peer) => messaging.serve(peer));

    return {
      username: identity.username,
      network,
      registry,
      identity: peerIdentity,
      messaging,
      async close() {
        const results = await Promise.allSettled([
          network.close(),
          closeAccountSession(),
        ]);
        const failure = results.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failure !== undefined) throw failure.reason;
      },
    };
  } catch (error) {
    await node.stop();
    throw error;
  }
}

function defaultBeaconAddress(): string {
  const transportSecurity = window.location.protocol === "https:" ? "/tls" : "";
  return `/dns4/${window.location.hostname}/tcp/${import.meta.env.BEACON_RELAY_PORT}${transportSecurity}/ws`;
}

async function waitForWebRtcAddress(
  node: Awaited<ReturnType<typeof createLibp2p>>,
  signal: AbortSignal,
): Promise<void> {
  const ready = () => node.getMultiaddrs().some((address) => address.toString().includes("/webrtc"));
  if (ready()) return;
  const readiness = AbortSignal.any([
    signal,
    AbortSignal.timeout(relayReservationTimeout),
  ]);

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      node.removeEventListener("self:peer:update", updated);
      readiness.removeEventListener("abort", aborted);
    };
    const updated = () => {
      if (!ready()) return;
      cleanup();
      resolve();
    };
    const aborted = () => {
      cleanup();
      reject(new Error(
        signal.aborted
          ? "Peer networking was closed before WebRTC became available."
          : "The Beacon did not provide a relay reservation.",
      ));
    };

    node.addEventListener("self:peer:update", updated);
    readiness.addEventListener("abort", aborted, { once: true });
    if (readiness.aborted) aborted();
  });
}
