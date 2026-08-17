import type { PromisedMethods } from "@c/backend/network";
import type { ServiceStorage } from "@v/backend/storage";

export const identityServiceName = "identity";

export interface Contact {
  readonly name: string;
}

export interface IdentityService {
  get(): Contact;
}

export function createIdentity(localName: string): IdentityService {
  return {
    get: () => ({ name: localName }),
  };
}

export async function loadContact(
  remote: PromisedMethods<IdentityService>,
  storage: ServiceStorage,
): Promise<Contact> {
  const contact = storage.singleton<Contact>();
  const cached = contact.get();
  if (cached !== undefined) return cached;

  const loaded = validateContact(await remote.get());
  contact.put(loaded);
  return loaded;
}

function validateContact(value: unknown): Contact {
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
