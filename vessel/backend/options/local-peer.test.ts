// @vitest-environment node

import { describe, expect, it } from "vitest";
import { createOptions } from "@v/backend/options";
import type {
  PersistentKeyValueStorage,
  PersistentServiceStorage,
} from "@v/backend/storage";
import {
  autoAcceptsConnections,
  observeAutoAcceptConnections,
  setAutoAcceptConnections,
} from "./local-peer";

async function testOptions() {
  const values = new Map<string, unknown>();
  const keyValues: PersistentKeyValueStorage<unknown> = {
    get: async (key) => values.get(key),
    put: async (key, value) => {
      values.set(key, value);
    },
    delete: async (key) => {
      values.delete(key);
    },
    entries: async () => [...values],
  };
  const storage: PersistentServiceStorage = {
    kv: <Value>() => keyValues as PersistentKeyValueStorage<Value>,
  };
  return { options: await createOptions(storage), values };
}

describe("local peer Options", () => {
  it("withholds automatic acceptance until it is granted", async () => {
    const { options, values } = await testOptions();

    expect(autoAcceptsConnections(options, "local-peer")).toBe(false);

    await setAutoAcceptConnections(options, "local-peer", true);
    expect(values.get("local-peer.auto_accept_connections")).toBeUndefined();
    expect(values.get("peers/local-peer.auto_accept_connections")).toBe(true);
    expect(autoAcceptsConnections(options, "local-peer")).toBe(true);
    expect(autoAcceptsConnections(options, "another-peer")).toBe(false);

    await setAutoAcceptConnections(options, "local-peer", false);
    expect(autoAcceptsConnections(options, "local-peer")).toBe(false);
  });

  it("observes only the named peer, and reads an absent setting as off", async () => {
    const { options } = await testOptions();
    const observed: boolean[] = [];
    const stop = observeAutoAcceptConnections(
      options,
      "local-peer",
      (accept) => observed.push(accept),
    );

    await setAutoAcceptConnections(options, "another-peer", true);
    await setAutoAcceptConnections(options, "local-peer", true);
    await options.cat("peers").obj("local-peer").unset("auto_accept_connections");
    stop();
    await setAutoAcceptConnections(options, "local-peer", true);

    expect(observed).toEqual([true, false]);
  });
});
