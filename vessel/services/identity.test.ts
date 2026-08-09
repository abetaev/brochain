import { describe, expect, it, vi } from "vitest";
import type { Peer } from "../../common/network.ts";
import { createStorage } from "../storage";
import { createIdentity } from "./identity";

function peer(id: string, get: () => Promise<unknown>): Peer {
  return {
    id,
    service: () => ({ get }),
  } as unknown as Peer;
}

describe("Identity", () => {
  it("serves the local Contact", () => {
    const identity = createIdentity("local", createStorage());

    expect(identity.serve(peer("remote", async () => ({}))).get()).toEqual({
      name: "local",
    });
  });

  it("fetches, validates, and caches each remote Contact", async () => {
    const getAda = vi.fn(async () => ({ name: "ada" }));
    const getBob = vi.fn(async () => ({ name: "bob" }));
    const identity = createIdentity("local", createStorage());
    const ada = identity.instance(peer("ada-id", getAda));
    const bob = identity.instance(peer("bob-id", getBob));

    await expect(ada.get()).resolves.toEqual({ name: "ada" });
    await expect(ada.get()).resolves.toEqual({ name: "ada" });
    await expect(bob.get()).resolves.toEqual({ name: "bob" });

    expect(getAda).toHaveBeenCalledOnce();
    expect(getBob).toHaveBeenCalledOnce();
  });

  it("rejects invalid remote identities without caching them", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ name: "Not valid" })
      .mockResolvedValueOnce({ name: "valid" });
    const identity = createIdentity("local", createStorage());
    const remote = identity.instance(peer("peer", get));

    await expect(remote.get()).rejects.toThrow("Peer returned an invalid identity.");
    await expect(remote.get()).resolves.toEqual({ name: "valid" });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("does not share cached Contacts between Sessions", async () => {
    const firstGet = vi.fn(async () => ({ name: "first" }));
    const secondGet = vi.fn(async () => ({ name: "second" }));
    const remotePeer = peer("peer", firstGet);
    const first = createIdentity("local", createStorage());
    const second = createIdentity("local", createStorage());

    await expect(first.instance(remotePeer).get()).resolves.toEqual({ name: "first" });
    const secondPeer = peer("peer", secondGet);
    await expect(second.instance(secondPeer).get()).resolves.toEqual({ name: "second" });
    expect(secondGet).toHaveBeenCalledOnce();
  });
});
