import type { Channel } from "../channel.ts";
import type { Peer } from "./peer.ts";
import type { Stream } from "./data.ts";
import type { RPC } from "./rpc.ts";

export type { RPC } from "./rpc.ts";

export type Methods = Readonly<Record<string, (...arguments_: never[]) => unknown>>;

export type AtLeastOne<Facets extends object> = {
  [Facet in keyof Facets]:
    & Required<Pick<Facets, Facet>>
    & Partial<Omit<Facets, Facet>>;
}[keyof Facets];

// A peer-bound service as its consumers use it: remote methods call the peer, events
// arrive from the peer, and data streams in either direction.
export type NetworkService<
  Remote extends Methods = Methods,
  Event extends object = object,
> = AtLeastOne<{
  readonly remote: RPC<Remote>;
  readonly events: Channel<Event>;
  readonly data: Stream;
}>;

// The same contract as its host declares it. `RPC` is the only difference: a host
// writes plain methods, and its peer calls them as promises.
export type HostedNetworkService<
  Remote extends Methods = Methods,
  Event extends object = object,
> = AtLeastOne<{
  readonly remote: Remote;
  readonly events: Channel<Event>;
  readonly data: Stream;
}>;

export type NetworkServiceFactory<
  Remote extends Methods = Methods,
  Event extends object = object,
> = (peer: Peer) => HostedNetworkService<Remote, Event>;

export type NetworkServiceFactories = Readonly<Record<string, NetworkServiceFactory>>;
