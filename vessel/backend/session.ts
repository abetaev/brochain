import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { identify, identifyPush } from "@libp2p/identify";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { createLibp2p } from "libp2p";
import { base64ToBytes } from "@c/base64";
import createNetwork, { type Network, type Peer } from "@c/backend/network";
import {
  createIdentity,
  identityServiceName,
} from "@v/backend/network/services/identity";
import { createSignals, type Signals } from "@v/backend/signals";
import {
  createDataStorage,
  type DataStorage,
} from "@v/backend/data-storage";
import {
  createStorage,
  type Storage,
} from "@v/backend/storage";

export interface Session {
  readonly username: string;
  network(): Promise<Network>;
  signals(): Signals;
  storage(): Storage;
  dataStorage(): Promise<DataStorage>;
  bootstrapError(): string | undefined;
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
  const active = await activeIdentity();
  if (active === undefined) throw new Error("The account is not unlocked.");
  const identity = active;

  const privateKey = await generateKeyPairFromSeed(
    "Ed25519",
    base64ToBytes(identity.identitySeed),
  );
  const signals = createSignals();
  const storage = createStorage();
  const lifetime = new AbortController();
  let beacon: Peer | undefined;
  let bootstrapAttempt: Promise<void> | undefined;
  let bootstrapFailure: string | undefined;
  let shutdown: Promise<void> | undefined;
  let closed = false;

  function requireOpen(): void {
    if (closed) throw new Error("This Session is closed.");
  }

  async function createRuntime() {
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

    const network = await createNetwork(node, {
      [identityServiceName]: {
        rpc: () => createIdentity(identity.username),
      },
    });
    return { network, node };
  }

  let runtime: ReturnType<typeof createRuntime> | undefined;
  let sessionData: ReturnType<typeof createDataStorage> | undefined;

  async function getRuntime() {
    requireOpen();
    if (runtime === undefined) runtime = createRuntime();
    try {
      return await runtime;
    } catch (error) {
      runtime = undefined;
      throw error;
    }
  }

  async function maintainBootstrap(
    current: Awaited<ReturnType<typeof createRuntime>>,
  ): Promise<void> {
    if (beacon?.isConnected()) {
      bootstrapFailure = undefined;
      return;
    }

    const attempt = bootstrapAttempt ??= (async () => {
      beacon = await bootstrap(
        current.network,
        async () => await waitForWebRtcAddress(current.node, lifetime.signal),
      );
    })();

    try {
      await attempt;
      bootstrapFailure = undefined;
    } catch (reason) {
      bootstrapFailure = errorMessage(reason);
    } finally {
      if (bootstrapAttempt === attempt) bootstrapAttempt = undefined;
    }
  }

  async function accessNetwork(): Promise<Network> {
    const current = await getRuntime();
    requireOpen();
    await maintainBootstrap(current);
    requireOpen();
    return current.network;
  }

  return {
    username: identity.username,
    network: accessNetwork,
    signals() {
      requireOpen();
      return signals;
    },
    storage() {
      requireOpen();
      return storage;
    },
    async dataStorage() {
      requireOpen();
      sessionData ??= createDataStorage();
      try {
        return await sessionData;
      } catch (reason) {
        sessionData = undefined;
        throw reason;
      }
    },
    bootstrapError: () => bootstrapFailure,
    async close() {
      if (shutdown === undefined) {
        closed = true;
        lifetime.abort();
        shutdown = (async () => {
          const results = await Promise.allSettled([
            runtime?.then(async ({ network }) => await network.close()),
            sessionData?.then(async (data) => await data.close()),
            closeAccountSession(),
          ]);
          const failure = results.find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
          if (failure !== undefined) throw failure.reason;
        })();
      }
      await shutdown;
    },
  };
}

async function bootstrap(
  network: Network,
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

function errorMessage(reason: unknown): string {
  return reason instanceof Error && reason.message.length > 0
    ? reason.message
    : "Unable to connect to the default Beacon.";
}
