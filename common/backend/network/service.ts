import type { Channel } from "../signals.ts";
import type { Peer } from "./peer.ts";
import type { Stream } from "./data.ts";

export type { RPC } from "./rpc.ts";

export type Methods = Readonly<Record<string, (...arguments_: never[]) => unknown>>;

// A peer-bound service as its host declares it. Its peer reaches the same facets,
// except that `RPC` turns the methods written here into promises the peer awaits.
export type NetworkService = {
  readonly remote?: Methods;
  readonly events?: Channel<unknown>;
  readonly data?: Stream;
};

export type NetworkServiceFactory = (peer: Peer) => NetworkService;

export type NetworkServiceFactories = Readonly<Record<string, NetworkServiceFactory>>;
