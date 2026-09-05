// @vitest-environment node

import { describe, expect, it } from "vitest";
import { createOptions } from "@v/backend/options";
import type {
  PersistentKeyValueStorage,
  PersistentServiceStorage,
} from "@v/backend/storage";
import {
  clearServiceEnabled,
  isServiceEnabled,
  observeServiceEnabled,
  overridesService,
  setServiceEnabled,
} from "./network-services";

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

const local = "this-peer";

describe("network service Options", () => {
  // Registry is the only thing a peer nobody has configured reaches, so a stranger
  // can read an empty catalog and stay connected while someone decides about it.
  it("grants an unconfigured peer nothing but Registry", async () => {
    const { options } = await testOptions();

    expect(isServiceEnabled(options, local, "peer-one", "registry")).toBe(true);
    expect(isServiceEnabled(options, local, "peer-one", "messaging")).toBe(false);
    expect(isServiceEnabled(options, local, local, "registry")).toBe(true);
    expect(isServiceEnabled(options, local, local, "messaging")).toBe(false);
  });

  it("answers for every peer which decides nothing of its own", async () => {
    const { options, values } = await testOptions();

    await setServiceEnabled(options, local, "messaging", true);

    expect(values.get(`peers/${local}/services/messaging.enabled`)).toBe(true);
    expect(isServiceEnabled(options, local, "peer-one", "messaging")).toBe(true);
    expect(isServiceEnabled(options, local, "peer-two", "messaging")).toBe(true);
    expect(isServiceEnabled(options, local, "peer-one", "calling")).toBe(false);

    await setServiceEnabled(options, local, "registry", false);
    expect(isServiceEnabled(options, local, "peer-one", "registry")).toBe(false);
  });

  it("lets a peer decide for itself, and follow the profile again", async () => {
    const { options } = await testOptions();
    await setServiceEnabled(options, local, "messaging", true);

    await setServiceEnabled(options, "peer-one", "messaging", false);

    expect(overridesService(options, "peer-one", "messaging")).toBe(true);
    expect(isServiceEnabled(options, local, "peer-one", "messaging")).toBe(false);
    expect(isServiceEnabled(options, local, "peer-two", "messaging")).toBe(true);

    // The profile moves on without it while the peer holds a value of its own.
    await setServiceEnabled(options, local, "messaging", false);
    expect(isServiceEnabled(options, local, "peer-one", "messaging")).toBe(false);

    await clearServiceEnabled(options, "peer-one", "messaging");
    expect(overridesService(options, "peer-one", "messaging")).toBe(false);
    expect(isServiceEnabled(options, local, "peer-one", "messaging")).toBe(false);

    await setServiceEnabled(options, local, "messaging", true);
    expect(isServiceEnabled(options, local, "peer-one", "messaging")).toBe(true);
  });

  it("observes only the selected peer and service, and reports a value withdrawn", async () => {
    const { options } = await testOptions();
    const observed: (boolean | undefined)[] = [];
    const stop = observeServiceEnabled(
      options,
      "peer-one",
      "messaging",
      (enabled) => observed.push(enabled),
    );

    await setServiceEnabled(options, "peer-one", "identity", false);
    await setServiceEnabled(options, "peer-two", "messaging", false);
    await setServiceEnabled(options, local, "messaging", false);
    await setServiceEnabled(options, "peer-one", "messaging", false);
    await clearServiceEnabled(options, "peer-one", "messaging");
    stop();

    expect(observed).toEqual([false, undefined]);
  });
});
