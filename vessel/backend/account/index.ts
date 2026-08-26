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

  return {
    list: () => backend.list(),
    create: (username, password) => authenticate(() => backend.create(username, password)),
    unlock: (username, password) => authenticate(() => backend.unlock(username, password)),
    delete: (username, password) => backend.delete(username, password),
    export: (username) => backend.export(username),
  };
}

export default createAccount();
