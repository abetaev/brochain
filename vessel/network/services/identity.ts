import type {
  Peer,
  PeerService,
  RemoteService,
  ServiceDefinition,
} from "../../../common/network/index.ts";
import type { Storage } from "../../services/storage.ts";

export const identityServiceName = "identity";

export interface Contact {
  readonly name: string;
}

export interface IdentityService extends PeerService<typeof identityServiceName> {
  get(): Contact;
}

export interface Identity {
  get(): Promise<Contact>;
}

export interface IdentityDefinition
  extends ServiceDefinition<IdentityService, Identity> {
  gateway(peer: Peer, remote: RemoteService<IdentityService>): Identity;
}

export function createIdentity(
  localName: string,
  storage: Storage,
): IdentityDefinition {
  return {
    name: identityServiceName,
    serve(_peer) {
      return {
        name: identityServiceName,
        get: () => ({ name: localName }),
      };
    },
    gateway(peer, remote) {
      const contact = storage.peer(peer).value<Contact>(identityServiceName);

      return {
        async get() {
          const cached = contact.get();
          if (cached !== undefined) return cached;

          const discovered = validContact(await remote.get());
          contact.put(discovered);
          return discovered;
        },
      };
    },
  };
}

function validContact(value: unknown): Contact {
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !/^[a-z]{1,64}$/.test(value.name)
  ) {
    throw new Error("Peer returned an invalid identity.");
  }
  return { name: value.name };
}
