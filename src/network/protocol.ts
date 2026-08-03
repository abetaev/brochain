export const CHAT_PROTOCOL = "/brochain/chat/1.0.0";

export type PeerPacket =
  | {
      type: "text";
      id: string;
      sentAt: string;
      text: string;
    }
  | {
      type: "file";
      id: string;
      sentAt: string;
      name: string;
      mediaType: string;
      data: string;
    };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodePacket(packet: PeerPacket): Uint8Array {
  return encoder.encode(JSON.stringify(packet));
}

export function decodePacket(bytes: Uint8Array): PeerPacket {
  const packet: unknown = JSON.parse(decoder.decode(bytes));

  if (typeof packet !== "object" || packet === null || typeof (packet as PeerPacket).type !== "string") {
    throw new Error("Invalid peer packet.");
  }

  if (
    (packet as PeerPacket).type === "text" &&
    typeof (packet as Extract<PeerPacket, { type: "text" }>).id === "string" &&
    typeof (packet as Extract<PeerPacket, { type: "text" }>).sentAt === "string" &&
    typeof (packet as Extract<PeerPacket, { type: "text" }>).text === "string"
  ) {
    return packet as Extract<PeerPacket, { type: "text" }>;
  }

  if (
    (packet as PeerPacket).type === "file" &&
    typeof (packet as Extract<PeerPacket, { type: "file" }>).id === "string" &&
    typeof (packet as Extract<PeerPacket, { type: "file" }>).sentAt === "string" &&
    typeof (packet as Extract<PeerPacket, { type: "file" }>).name === "string" &&
    typeof (packet as Extract<PeerPacket, { type: "file" }>).mediaType === "string" &&
    typeof (packet as Extract<PeerPacket, { type: "file" }>).data === "string"
  ) {
    return packet as Extract<PeerPacket, { type: "file" }>;
  }

  throw new Error("Unsupported peer packet.");
}

export function bytesToBase64(bytes: Uint8Array): string {
  let value = "";

  for (const byte of bytes) {
    value += String.fromCharCode(byte);
  }

  return btoa(value);
}

export function base64ToBytes(value: string): Uint8Array {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
