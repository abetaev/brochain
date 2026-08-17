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

export function validateContact(value: unknown): Contact {
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
