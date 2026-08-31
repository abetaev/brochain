import signals from "../../signals.ts";
import type { Channel, Subscription } from "../../signals.ts";
import type { RPC } from "../service.ts";

type RegistryMethods = {
  list(): readonly string[];
  announce(services: readonly string[]): void;
};

export interface CatalogUpdate {
  readonly services: readonly string[];
}

export type Registry = {
  readonly remote: RPC<RegistryMethods>;
  readonly events: Subscription<CatalogUpdate>;
};

export const registryServiceName = "registry";

// A peer asks for the catalog once and is told of every later change, so the two
// directions follow the same shape as any other service: call to push, observe to
// receive.
export function createRegistry(
  hostedServiceNames: () => readonly string[],
): { readonly remote: RegistryMethods; readonly events: Channel<CatalogUpdate> } {
  const events = signals.channel<CatalogUpdate>();

  return {
    remote: {
      list: hostedServiceNames,
      announce: (services) => events.publish({ services: validateServiceNames(services) }),
    },
    events,
  };
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
