import type { PromisedMethods } from "@c/backend/network";

export const identityServiceName = "identity";

export interface Identity {
  readonly name: string;
}

export interface IdentityService {
  get(): Identity;
}

export function createIdentity(localName: string): IdentityService {
  return {
    get: () => ({ name: localName }),
  };
}

export async function loadIdentity(
  remote: PromisedMethods<IdentityService>,
): Promise<Identity> {
  return validateIdentity(await remote.get());
}

export function validateIdentity(value: unknown): Identity {
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !/^[a-z]{1,64}$/.test(value.name)
  ) {
    throw new Error("Peer returned an invalid identity.");
  }
  return Object.freeze({ name: value.name });
}
