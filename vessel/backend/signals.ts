import { createChannel, type Channel } from "@c/backend/channel";

export type { Channel } from "@c/backend/channel";

export interface Signals {
  channel<Event>(owner: object, name: string): Channel<Event>;
}

export function createSignals(): Signals {
  const owners = new WeakMap<object, Map<string, Channel<unknown>>>();

  return {
    channel<Event>(owner: object, name: string): Channel<Event> {
      let channels = owners.get(owner);
      if (channels === undefined) {
        channels = new Map();
        owners.set(owner, channels);
      }

      let existing = channels.get(name);
      if (existing === undefined) {
        existing = createChannel<unknown>();
        channels.set(name, existing);
      }
      return existing as Channel<Event>;
    },
  };
}
