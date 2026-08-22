import { describe, expect, it } from "vitest";
import type { PromisedMethods } from "@c/backend/network";
import { createStorage, type ServiceStorage } from "@v/backend/storage";
import {
  createIdentity,
  loadContact,
  type IdentityService,
} from "./identity.ts";

function contactStorage(
  peerId = "remote-peer",
  storage = createStorage(),
): ServiceStorage {
  return storage.peer(peerId).service("identity");
}

function remoteIdentity(get: () => Promise<unknown>): PromisedMethods<IdentityService> {
  return { get } as PromisedMethods<IdentityService>;
}

describe("Identity", () => {
  it("exposes the local Contact as a plain service object", () => {
    const identity = createIdentity("local");

    expect(identity).toEqual({ get: expect.any(Function) });
    expect(identity.get()).toEqual({ name: "local" });
    expect("name" in identity).toBe(false);
  });

  it("validates and caches a remote Contact in its designated singleton", async () => {
    let calls = 0;
    const remote = remoteIdentity(async () => {
      calls += 1;
      return { name: "ada" };
    });
    const storage = contactStorage();

    await expect(loadContact(remote, storage)).resolves.toEqual({ name: "ada" });
    await expect(loadContact(remoteIdentity(async () => ({ name: "ignored" })), storage))
      .resolves.toEqual({ name: "ada" });

    expect(calls).toBe(1);
    expect(storage.singleton().get()).toEqual({ name: "ada" });
  });

  it.each([
    { name: "Not valid" },
    { name: 1 },
    null,
  ])("rejects an invalid remote Contact without caching it", async (value) => {
    const storage = contactStorage();

    await expect(loadContact(remoteIdentity(async () => value), storage)).rejects.toThrow(
      "Peer returned an invalid identity.",
    );
    expect(storage.singleton().get()).toBeUndefined();
  });

  it("isolates cached Contacts by peer and Session storage", async () => {
    const firstSession = createStorage();
    const secondSession = createStorage();
    const firstPeer = contactStorage("first", firstSession);
    const secondPeer = contactStorage("second", firstSession);
    const nextSession = contactStorage("first", secondSession);

    await loadContact(remoteIdentity(async () => ({ name: "ada" })), firstPeer);
    await loadContact(remoteIdentity(async () => ({ name: "bea" })), secondPeer);
    await loadContact(remoteIdentity(async () => ({ name: "cy" })), nextSession);

    expect(firstPeer.singleton().get()).toEqual({ name: "ada" });
    expect(secondPeer.singleton().get()).toEqual({ name: "bea" });
    expect(nextSession.singleton().get()).toEqual({ name: "cy" });
  });
});
