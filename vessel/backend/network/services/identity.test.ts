import { describe, expect, it } from "vitest";
import {
  createIdentity,
  loadIdentity,
  validateIdentity,
} from "./identity.ts";

function remoteIdentity(get: () => Promise<unknown>): Parameters<typeof loadIdentity>[0] {
  return { get } as Parameters<typeof loadIdentity>[0];
}

describe("Identity", () => {
  it("exposes the local Identity as a plain service object", () => {
    const identity = createIdentity("local");

    expect(identity).toEqual({ remote: { get: expect.any(Function) } });
    expect(identity.remote.get()).toEqual({ name: "local" });
    expect("name" in identity).toBe(false);
  });

  it("loads and validates every remote Identity request without retention", async () => {
    let name = "ada";
    const get = async () => ({ name });
    const remote = remoteIdentity(get);

    await expect(loadIdentity(remote)).resolves.toEqual({ name: "ada" });
    name = "bea";
    await expect(loadIdentity(remote)).resolves.toEqual({ name: "bea" });
  });

  it.each([
    { name: "Not valid" },
    { name: 1 },
    null,
  ])("rejects an invalid Identity", async (value) => {
    await expect(loadIdentity(remoteIdentity(async () => value))).rejects.toThrow(
      "Peer returned an invalid identity.",
    );
    expect(() => validateIdentity(value)).toThrow("Peer returned an invalid identity.");
  });

  it("returns a normalized immutable Identity", () => {
    const identity = validateIdentity({ name: "ada", ignored: true });

    expect(identity).toEqual({ name: "ada" });
    expect(Object.isFrozen(identity)).toBe(true);
  });
});
