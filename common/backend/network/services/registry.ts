import type { RPC } from "../service.ts";

export type RegistryMethods = {
  list(): readonly string[];
};

export type Registry = {
  readonly remote: RPC<RegistryMethods>;
};

export const registryServiceName = "registry";

export function createRegistry(
  hostedServiceNames: () => readonly string[],
): { readonly remote: RegistryMethods } {
  return { remote: { list: hostedServiceNames } };
}

export function validateServiceNames(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((name) => typeof name === "string" && name.length > 0) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("Peer returned invalid service names.");
  }
  return [...value];
}
