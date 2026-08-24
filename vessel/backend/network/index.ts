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
} from "@c/backend/network";
import {
  createIdentity,
  identityServiceName,
} from "./services/identity";

export interface Network {
  id(): Promise<string>;
  access(): Promise<CommonNetwork>;
  bootstrapError(): string | undefined;
  close(): Promise<void>;
}

const relayReservationTimeout = 5_000;

export function createNetwork(name: string, identitySeed: string): Network {
  const lifetime = new AbortController();
  let initialization: Promise<CommonNetwork> | undefined;
  let beacon: Peer | undefined;
  let bootstrapAttempt: Promise<void> | undefined;
  let bootstrapFailure: string | undefined;
  let shutdown: Promise<void> | undefined;

  async function initialize(): Promise<CommonNetwork> {
    const privateKey = await generateKeyPairFromSeed(
      "Ed25519",
      base64ToBytes(identitySeed),
    );
    return await createCommonNetwork({
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
    }, {
      [identityServiceName]: {
        rpc: () => createIdentity(name),
      },
    });
  }

  async function accessRuntime(): Promise<CommonNetwork> {
    const attempt = initialization ??= initialize();
    try {
      return await attempt;
    } catch (error) {
      if (initialization === attempt) initialization = undefined;
      throw error;
    }
  }

  async function maintainBootstrap(network: CommonNetwork): Promise<void> {
    if (beacon?.isConnected()) {
      bootstrapFailure = undefined;
      return;
    }

    const attempt = bootstrapAttempt ??= (async () => {
      beacon = await bootstrap(
        network,
        async () => await waitForWebRtcAddress(network, lifetime.signal),
      );
    })();
    try {
      await attempt;
      bootstrapFailure = undefined;
    } catch (reason) {
      if (!lifetime.signal.aborted) bootstrapFailure = errorMessage(reason);
    } finally {
      if (bootstrapAttempt === attempt) bootstrapAttempt = undefined;
    }
  }

  return {
    async id() {
      return (await accessRuntime()).id;
    },
    async access() {
      const network = await accessRuntime();
      if (!lifetime.signal.aborted) await maintainBootstrap(network);
      return network;
    },
    bootstrapError: () => bootstrapFailure,
    async close() {
      if (shutdown === undefined) {
        lifetime.abort();
        const pending = initialization;
        shutdown = (async () => {
          const network = await pending?.catch(() => undefined);
          await network?.close();
        })();
      }
      await shutdown;
    },
  };
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
