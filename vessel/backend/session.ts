import type { Network } from "@c/backend/network";
import {
  createNetwork,
  type Network as NetworkComponent,
} from "@v/backend/network";
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
  options(): Options;
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

export async function createSession(
  activeIdentity: () => Promise<ActiveIdentity | undefined>,
  closeAccountSession: () => Promise<void>,
): Promise<Session> {
  const identity = await activeIdentity();
  if (identity === undefined) throw new Error("The account is not unlocked.");

  const signals = createSignals();
  const storage = await createStorage(identity.username);
  let network: NetworkComponent;
  try {
    network = await createNetwork(identity.username, identity.identitySeed);
  } catch (reason) {
    await storage.close().catch(() => {});
    throw reason;
  }

  let options: Options;
  try {
    options = await createOptions(
      storage.persistent.peer(network.id).service("options"),
      signals,
    );
  } catch (reason) {
    await Promise.allSettled([network.close(), storage.close()]);
    throw reason;
  }

  let shutdown: Promise<void> | undefined;

  function accessStorage(): VolatileStorage;
  function accessStorage(options: { readonly persistent?: false }): VolatileStorage;
  function accessStorage(options: { readonly persistent: true }): PersistentStorage;
  function accessStorage(
    options?: { readonly persistent?: boolean },
  ): VolatileStorage | PersistentStorage {
    return options?.persistent === true ? storage.persistent : storage;
  }

  return {
    username: identity.username,
    network: network.access,
    options: () => options,
    signals: () => signals,
    storage: accessStorage,
    bootstrapError: network.bootstrapError,
    async close() {
      if (shutdown === undefined) {
        shutdown = (async () => {
          const results = await Promise.allSettled([
            network.close(),
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
