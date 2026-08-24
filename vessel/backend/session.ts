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
import { createOptions, type Options } from "@v/backend/options";
import { createSignals, type Signals } from "@v/backend/signals";
import {
  createStorage,
  type PersistentStorage,
  type VolatileStorage,
} from "@v/backend/storage";

export interface Session {
  readonly username: string;
  network(): Promise<Network>;
  options(): Promise<Options>;
  signals(): Signals;
  storage(options?: { readonly persistent?: false }): VolatileStorage;
  storage(options: { readonly persistent: true }): PersistentStorage;
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
  const storage = createStorage(identity.username);
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
  let options: ReturnType<typeof createOptions> | undefined;

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

  async function accessOptions(): Promise<Options> {
    requireOpen();
    const attempt = options ??= getRuntime().then(async ({ network }) => {
      requireOpen();
      return await createOptions(
        storage.persistent.peer(network.id).service("options"),
        signals,
      );
    });

    try {
      const initialized = await attempt;
      requireOpen();
      return initialized;
    } catch (error) {
      if (!closed && options === attempt) options = undefined;
      throw error;
    }
  }

  function accessStorage(): VolatileStorage;
  function accessStorage(options: { readonly persistent?: false }): VolatileStorage;
  function accessStorage(options: { readonly persistent: true }): PersistentStorage;
  function accessStorage(
    options?: { readonly persistent?: boolean },
  ): VolatileStorage | PersistentStorage {
    requireOpen();
    return options?.persistent === true ? storage.persistent : storage;
  }

  return {
    username: identity.username,
    network: accessNetwork,
    options: accessOptions,
    signals() {
      requireOpen();
      return signals;
    },
    storage: accessStorage,
    bootstrapError: () => bootstrapFailure,
    async close() {
      if (shutdown === undefined) {
        closed = true;
        lifetime.abort();
        shutdown = (async () => {
          const results = await Promise.allSettled([
            runtime?.then(async ({ network }) => await network.close()),
            storage.close(),
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
