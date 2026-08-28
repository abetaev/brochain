// @vitest-environment node

import { describe, expect, it } from "vitest";
import { createOptions } from "@v/backend/options";
import { createSignals } from "@v/backend/signals";
import type {
  PersistentKeyValueStorage,
  PersistentServiceStorage,
} from "@v/backend/storage";
import { isServiceEnabled } from "./network-services";

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
  return { options: await createOptions(storage, createSignals()), values };
}

describe("network service Options", () => {
  it("defaults to enabled and isolates peer and service settings", async () => {
    const { options, values } = await testOptions();
    const configured = options.cat("peers").obj("peer-one")
      .cat("services").obj("messaging");

    expect(isServiceEnabled(options, "peer-one", "messaging")).toBe(true);
    await configured.set("enabled", false);

    expect(values.get("peers/peer-one/services/messaging.enabled")).toBe(false);
    expect(isServiceEnabled(options, "peer-one", "messaging")).toBe(false);
    expect(isServiceEnabled(options, "peer-one", "identity")).toBe(true);
    expect(isServiceEnabled(options, "peer-two", "messaging")).toBe(true);

    await configured.set("enabled", true);
    expect(isServiceEnabled(options, "peer-one", "messaging")).toBe(true);
  });
});
