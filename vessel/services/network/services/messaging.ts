import type { ServiceStorage } from "../../storage.ts";

export const messagingServiceName = "messaging";

export type MessageContent = Readonly<
  { type: "text"; text: string } | { type: "file"; file: File }
>;

export type MessagingEvent = Readonly<
  | { type: "sent"; content: MessageContent }
  | { type: "received"; content: MessageContent }
  | { type: "failed"; error: string }
>;

export interface TransferredFile {
  readonly name: string;
  readonly mediaType: string;
  readonly data: Uint8Array;
}

export interface MessagingService {
  sendText(text: string): void;
  sendFile(file: TransferredFile): void;
}

export function createMessaging(storage: ServiceStorage): MessagingService {
  const events = storage.event<MessagingEvent>();

  return {
    sendText(value) {
      const text = validateMessageText(value);
      events.append({
        type: "received",
        content: { type: "text", text },
      });
    },
    sendFile(value) {
      const file = validateTransferredFile(value);
      events.append({
        type: "received",
        content: {
          type: "file",
          file: new File([Uint8Array.from(file.data)], file.name, {
            type: file.mediaType,
          }),
        },
      });
    },
  };
}

export function validateMessageText(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Enter a message.");
  }
  return value;
}

function validateTransferredFile(value: unknown): TransferredFile {
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("mediaType" in value) ||
    typeof value.mediaType !== "string" ||
    !("data" in value) ||
    !isByteArray(value.data)
  ) {
    throw new Error("Peer sent an invalid file.");
  }
  return { name: value.name, mediaType: value.mediaType, data: value.data };
}

export async function transferFile(file: File): Promise<TransferredFile> {
  return {
    name: file.name,
    mediaType: file.type || "application/octet-stream",
    data: new Uint8Array(await file.arrayBuffer()),
  };
}

export function messageDeliveryError(reason: unknown): string {
  if (reason instanceof Error && reason.message.length > 0) return reason.message;
  if (typeof reason === "string" && reason.length > 0) return reason;
  return "Message delivery failed.";
}

function isByteArray(value: unknown): value is Uint8Array {
  return Object.prototype.toString.call(value) === "[object Uint8Array]";
}
