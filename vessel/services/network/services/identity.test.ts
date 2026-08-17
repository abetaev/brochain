import { describe, expect, it } from "vitest";
import {
  createIdentity,
  validateContact,
} from "./identity.ts";

describe("Identity", () => {
  it("exposes the local Contact as a plain service object", () => {
    const identity = createIdentity("local");

    expect(identity).toEqual({ get: expect.any(Function) });
    expect(identity.get()).toEqual({ name: "local" });
    expect("name" in identity).toBe(false);
  });

  it("validates remote Contacts without retaining caller state", () => {
    expect(validateContact({ name: "ada" })).toEqual({ name: "ada" });
    expect(() => validateContact({ name: "Not valid" })).toThrow(
      "Peer returned an invalid identity.",
    );
    expect(() => validateContact({ name: 1 })).toThrow(
      "Peer returned an invalid identity.",
    );
    expect(() => validateContact(null)).toThrow(
      "Peer returned an invalid identity.",
    );
  });
});
