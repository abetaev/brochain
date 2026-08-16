import type { Peer, ServiceDefinition } from "../peer.ts";
import type { PeerService } from "../rpc.ts";

export interface Registry {
  list(): Promise<readonly string[]>;
}

interface RegistryRpc extends PeerService<typeof registryServiceName> {
  list(): readonly string[];
}

export interface RegistryService extends ServiceDefinition<RegistryRpc, Registry> {}

export const registryServiceName = "registry";

export function createRegistryService(
  hostedServiceNames: () => readonly string[],
): RegistryService {
  return {
    name: registryServiceName,
    serve(_peer: Peer): RegistryRpc {
      return {
        name: registryServiceName,
        list: hostedServiceNames,
      };
    },
    gateway(_peer, remote): Registry {
      return {
        async list() {
          const names: unknown = await remote.list();
          if (
            !Array.isArray(names) ||
            !names.every((name) => typeof name === "string" && name.length > 0) ||
            !names.includes(registryServiceName) ||
            new Set(names).size !== names.length
          ) {
            throw new Error("Peer returned invalid service names.");
          }
          return [...names];
        },
      };
    },
  };
}
