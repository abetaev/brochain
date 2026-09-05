import { transfer, wrap } from "comlink";
import type { Session } from "@v/backend/session";
import {
  createAuthenticator,
  openAuthenticator,
  supportsAuthenticator,
} from "./authenticator.ts";
import type { AccountService, SessionAccess } from "./service.ts";

interface Account {
  list(): Promise<string[]>;
  create(username: string, password: string): Promise<Session>;
  unlock(username: string, password: string): Promise<Session>;
  delete(username: string, password: string): Promise<boolean>;
  export(username: string): Promise<string>;
  /** Whether this device can unlock an account at all, which not every one can. */
  canEnrolAuthenticator(): Promise<boolean>;
  hasAuthenticator(username: string): Promise<boolean>;
  /** Wraps the unlocked account's secrets for this device. */
  enrolAuthenticator(): Promise<void>;
  removeAuthenticator(): Promise<void>;
  unlockWithAuthenticator(username: string): Promise<Session>;
}

function createAccount(): Account {
  const worker = new Worker(new URL("./main.ts", import.meta.url), { type: "module" });
  const backend = wrap<AccountService>(worker);
  const channel = new MessageChannel();
  const access = wrap<SessionAccess>(channel.port1);
  const ready = backend.openSession(transfer(channel.port2, [channel.port2]));
  let active: Session | undefined;

  async function authenticate(operation: () => Promise<unknown>): Promise<Session> {
    await active?.close();
    await ready;
    await operation();
    try {
      const { createSession } = await import("@v/backend/session");
      const session = await createSession(
        async () => await access.activePeerIdentity(),
        async () => {
          await access.closeSession();
          active = undefined;
        },
      );
      return (active = session);
    } catch (error) {
      await access.closeSession();
      throw error;
    }
  }

  // The ceremony runs here rather than in the Worker, and only its result crosses
  // — the way a password already does, and the seed never does.
  async function enrolAuthenticator(): Promise<void> {
    if (active === undefined) throw new Error("The account is not unlocked.");

    const { credentialId, salt, secret } = await createAuthenticator(active.username);
    await backend.enrolAuthenticator(credentialId, salt, secret);
  }

  async function unlockWithAuthenticator(username: string): Promise<Session> {
    const credential = await backend.authenticator(username);

    if (credential === undefined) {
      throw new Error("This device does not unlock that account.");
    }

    const secret = await openAuthenticator(credential.credentialId, credential.salt);
    return await authenticate(async () =>
      await backend.unlockWithAuthenticator(username, secret));
  }

  return {
    list: () => backend.list(),
    create: (username, password) => authenticate(() => backend.create(username, password)),
    unlock: (username, password) => authenticate(() => backend.unlock(username, password)),
    delete: (username, password) => backend.delete(username, password),
    export: (username) => backend.export(username),
    canEnrolAuthenticator: () => supportsAuthenticator(),
    hasAuthenticator: async (username) =>
      await backend.authenticator(username) !== undefined,
    enrolAuthenticator,
    removeAuthenticator: () => backend.removeAuthenticator(),
    unlockWithAuthenticator,
  };
}

export default createAccount();
