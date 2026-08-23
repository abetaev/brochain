import { transfer, wrap } from "comlink";
import type { Session } from "@v/backend/session";
import type { AccountService, SessionAccess } from "./service.ts";

interface Account {
  list(): Promise<string[]>;
  create(username: string, password: string): Promise<Session>;
  unlock(username: string, password: string): Promise<Session>;
  delete(username: string, password: string): Promise<boolean>;
  export(username: string): Promise<string>;
}

function createAccount(): Account {
  const worker = new Worker(new URL("./main.ts", import.meta.url), { type: "module" });
  const backend = wrap<AccountService>(worker);
  const channel = new MessageChannel();
  const access = wrap<SessionAccess>(channel.port1);
  const ready = backend.openSession(transfer(channel.port2, [channel.port2]));
  let active: Session | undefined;
  let authentication = Promise.resolve();

  async function authenticate(operation: () => Promise<unknown>): Promise<Session> {
    await active?.close();
    await ready;
    await operation();
    let session: Session;
    try {
      const { createSession } = await import("@v/backend/session");
      session = await createSession(
        async () => await access.activePeerIdentity(),
        async () => {
          if (active !== session) return;
          await access.closeSession();
          if (active === session) active = undefined;
        },
      );
    } catch (error) {
      await access.closeSession();
      throw error;
    }
    return (active = session);
  }

  function queueAuthentication(operation: () => Promise<unknown>): Promise<Session> {
    const result = authentication.then(async () => await authenticate(operation));
    authentication = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    list: () => backend.list(),
    create: (username, password) =>
      queueAuthentication(() => backend.create(username, password)),
    unlock: (username, password) =>
      queueAuthentication(() => backend.unlock(username, password)),
    delete: (username, password) => backend.delete(username, password),
    export: (username) => backend.export(username),
  };
}

export default createAccount();
