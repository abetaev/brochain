import type { Network } from "@c/backend/network";
import { createNetwork } from "@v/backend/network";
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

export async function createSession(
  activeIdentity: () => Promise<ActiveIdentity | undefined>,
  closeAccountSession: () => Promise<void>,
): Promise<Session> {
  const identity = await activeIdentity();
  if (identity === undefined) throw new Error("The account is not unlocked.");

  const signals = createSignals();
  const storage = createStorage(identity.username);
  const network = createNetwork(identity.username, identity.identitySeed);
  let options: Promise<Options> | undefined;
  let shutdown: Promise<void> | undefined;

  async function accessOptions(): Promise<Options> {
    const attempt = options ??= (async () => await createOptions(
      storage.persistent.peer(await network.id()).service("options"),
      signals,
    ))();
    try {
      return await attempt;
    } catch (error) {
      if (options === attempt) options = undefined;
      throw error;
    }
  }

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
    options: accessOptions,
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
