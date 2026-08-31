import type { RPC } from "@c/backend/network";

export const identityServiceName = "identity";

export interface Identity {
  readonly name: string;
}

type Remote = {
  get(): Identity;
};

export type IdentityService = {
  readonly remote: RPC<Remote>;
};

export function createIdentity(localName: string): { readonly remote: Remote } {
  return { remote: { get: () => ({ name: localName }) } };
}

export async function loadIdentity(service: IdentityService): Promise<Identity> {
  return validateIdentity(await service.remote.get());
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
