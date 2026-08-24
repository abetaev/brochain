import type { Channel, Signals } from "./signals";
import type { PersistentServiceStorage } from "./storage";

export type OptionValue = string | number | boolean | null;

export interface OptionChange {
  readonly key: string;
  readonly value: OptionValue | undefined;
}

export interface Options {
  readonly changes: Channel<OptionChange>;
  get(key: string): OptionValue | undefined;
  set(key: string, value: OptionValue): Promise<void>;
  unset(key: string): Promise<void>;
}

export async function createOptions(
  storage: PersistentServiceStorage,
  signals: Signals,
): Promise<Options> {
  const persisted = storage.kv<unknown>();
  const values = new Map<string, OptionValue>();

  for (const [key, value] of await persisted.entries()) {
    if (isOptionValue(value)) values.set(key, value);
    else await persisted.delete(key);
  }

  const changes = signals.channel<OptionChange>({}, "changes");
  let mutations = Promise.resolve();

  function mutate(operation: () => Promise<void>): Promise<void> {
    const result = mutations.then(operation);
    mutations = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    changes,
    get: (key) => values.get(key),
    async set(key, value) {
      if (!isOptionValue(value)) {
        throw new TypeError("Options support only scalar values.");
      }

      await mutate(async () => {
        if (Object.is(values.get(key), value)) return;
        await persisted.put(key, value);
        values.set(key, value);
        changes.publish({ key, value });
      });
    },
    async unset(key) {
      await mutate(async () => {
        if (!values.has(key)) return;
        await persisted.delete(key);
        values.delete(key);
        changes.publish({ key, value: undefined });
      });
    },
  };
}

function isOptionValue(value: unknown): value is OptionValue {
  return value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean";
}
