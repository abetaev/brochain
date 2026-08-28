import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { identify, identifyPush } from "@libp2p/identify";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { base64ToBytes } from "@c/base64";
import createCommonNetwork, {
  type Network as CommonNetwork,
  type Peer,
  type Services,
} from "@c/backend/network";

export interface Network {
  readonly id: string;
  access(): Promise<CommonNetwork>;
  provide(services: Services): Promise<void>;
  bootstrapError(): string | undefined;
  close(): Promise<void>;
}

const relayReservationTimeout = 5_000;

export async function createNetwork(identitySeed: string): Promise<Network> {
  const lifetime = new AbortController();
  const privateKey = await generateKeyPairFromSeed(
    "Ed25519",
    base64ToBytes(identitySeed),
  );
  const network = await createCommonNetwork({
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
  let beacon: Peer | undefined;
  let bootstrapFailure: string | undefined;
  let shutdown: Promise<void> | undefined;

  async function maintainBootstrap(): Promise<void> {
    if (beacon?.isConnected()) {
      bootstrapFailure = undefined;
      return;
    }

    try {
      beacon = await bootstrap(
        network,
        async () => await waitForWebRtcAddress(network, lifetime.signal),
      );
      bootstrapFailure = undefined;
    } catch (reason) {
      if (!lifetime.signal.aborted) bootstrapFailure = errorMessage(reason);
    }
  }

  const component: Network = {
    id: network.id,
    async access() {
      if (!lifetime.signal.aborted) await maintainBootstrap();
      return network;
    },
    provide: network.provide,
    bootstrapError: () => bootstrapFailure,
    async close() {
      if (shutdown === undefined) {
        lifetime.abort();
        shutdown = network.close();
      }
      await shutdown;
    },
  };
  await maintainBootstrap();
  return component;
}

async function bootstrap(
  network: CommonNetwork,
  ready: () => Promise<void>,
): Promise<Peer> {
  const created = await network.createPeer(defaultBeaconAddress());
  const peer = await created.connect();
  await ready();
  return peer;
}

function defaultBeaconAddress(): string {
  const tls = window.location.protocol === "https:" ? "/tls" : "";
  return `/dns4/${window.location.hostname}/tcp/${import.meta.env.BEACON_RELAY_PORT}${tls}/ws`;
}

async function waitForWebRtcAddress(
  network: CommonNetwork,
  signal: AbortSignal,
): Promise<void> {
  const ready = () => network.addresses().some((address) => address.includes("/webrtc"));
  if (ready()) return;
  const readiness = AbortSignal.any([
    signal,
    AbortSignal.timeout(relayReservationTimeout),
  ]);

  await new Promise<void>((resolve, reject) => {
    let unsubscribe = () => {};
    const cleanup = () => {
      unsubscribe();
      readiness.removeEventListener("abort", aborted);
    };
    const updated = () => {
      if (!ready()) return;
      cleanup();
      resolve();
    };
    const aborted = () => {
      cleanup();
      reject(new Error("The Beacon did not provide a relay reservation."));
    };

    unsubscribe = network.subscribeAddresses(updated);
    readiness.addEventListener("abort", aborted, { once: true });
    if (readiness.aborted) aborted();
    else updated();
  });
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error && reason.message.length > 0
    ? reason.message
    : "Unable to connect to the default Beacon.";
}
