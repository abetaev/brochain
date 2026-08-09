import type { Peer } from "../../common/network.ts";
import type { PeerService } from "../../common/rpc.ts";
import type { StorageFactory } from "../storage";

interface Contact {
  readonly name: string;
}

const serviceName = "identity";

interface IdentityService extends PeerService<typeof serviceName> {
  get(): Contact;
}

export function createIdentity(localName: string, storage: StorageFactory) {
  return {
    serve(_peer: Peer): IdentityService {
      return {
        name: serviceName,
        get: () => ({ name: localName }),
      };
    },
    instance(peer: Peer) {
      const contact = storage.value<Contact>(peer.id, serviceName);

      return {
        async get(): Promise<Contact> {
          const cached = contact.get();
          if (cached !== undefined) return cached;

          const discovered = validContact(
            await peer.service<IdentityService>(serviceName).get(),
          );
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
