import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64, decodePacket, encodePacket } from "./protocol";

describe("peer protocol", () => {
  it("round-trips text and file packets", () => {
    const text = { type: "text" as const, id: "message-1", sentAt: "2026-08-02T00:00:00.000Z", text: "Hello" };
    const file = {
      type: "file" as const,
      id: "file-1",
      sentAt: "2026-08-02T00:00:00.000Z",
      name: "note.txt",
      mediaType: "text/plain",
      data: "SGVsbG8=",
    };

    expect(decodePacket(encodePacket(text))).toEqual(text);
    expect(decodePacket(encodePacket(file))).toEqual(file);
  });

  it("round-trips binary file data", () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});
