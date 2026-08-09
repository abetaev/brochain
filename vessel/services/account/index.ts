import { transfer, wrap, type RemoteObject } from "comlink";
import { createSession, type Session } from "@/session";
import type { AccountService, SessionAccess } from "./service.ts";

type Account = Omit<
  RemoteObject<AccountService>,
  "create" | "unlock" | "openSession"
> & {
  create(username: string, password: string): Promise<Session>;
  unlock(username: string, password: string): Promise<Session>;
};

function createAccount(): Account {
  const worker = new Worker(new URL("./service.ts", import.meta.url), { type: "module" });
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

  const create = (username: string, password: string) =>
    queueAuthentication(async () => await backend.create(username, password));
  const unlock = (username: string, password: string) =>
    queueAuthentication(async () => await backend.unlock(username, password));

  return new Proxy(backend as unknown as Account, {
    get(target, property) {
      if (property === "create") return create;
      if (property === "unlock") return unlock;
      return Reflect.get(target, property);
    },
  });
}

export default createAccount();
