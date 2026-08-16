import type {
  Peer,
  PeerService,
  RemoteService,
  ServiceDefinition,
} from "../../../common/network/index.ts";
import type {
  EventStorage,
  Storage,
  ValueStorage,
} from "../../services/storage.ts";

export const messagingServiceName = "messaging";
const deliveryStorageName = "delivery";

type MessageContent = Readonly<
  { type: "text"; text: string } | { type: "file"; file: File }
>;

export type MessagingEvent = Readonly<
  | { type: "sent"; content: MessageContent }
  | { type: "received"; content: MessageContent }
  | { type: "failed"; error: string }
>;

interface TransferredFile {
  readonly name: string;
  readonly mediaType: string;
  readonly data: Uint8Array;
}

export interface MessagingService extends PeerService<typeof messagingServiceName> {
  sendText(text: string): void;
  sendFile(file: TransferredFile): void;
}

export interface Messaging {
  sendText(text: string): void;
  sendFile(file: File): void;
}

export interface MessagingDefinition
  extends ServiceDefinition<MessagingService, Messaging> {
  gateway(peer: Peer, remote: RemoteService<MessagingService>): Messaging;
}

export function createMessaging(storage: Storage): MessagingDefinition {
  return {
    name: messagingServiceName,
    serve(peer) {
      const events = storage.peer(peer).events<MessagingEvent>(messagingServiceName);

      return {
        name: messagingServiceName,
        sendText(text) {
          requireText(text);
          events.append({
            type: "received",
            content: { type: "text", text },
          });
        },
        sendFile(value) {
          const file = requireFile(value);
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
    },
    gateway(peer, remote) {
      const peerStorage = storage.peer(peer);
      const events = peerStorage.events<MessagingEvent>(messagingServiceName);
      const delivery = peerStorage.value<Promise<void>>(
        messagingServiceName,
        deliveryStorageName,
      );

      return {
        sendText(text) {
          requireText(text);
          events.append({ type: "sent", content: { type: "text", text } });
          queue(delivery, events, async () => await remote.sendText(text));
        },
        sendFile(file) {
          events.append({ type: "sent", content: { type: "file", file } });
          queue(delivery, events, async () => {
            await remote.sendFile({
              name: file.name,
              mediaType: file.type || "application/octet-stream",
              data: new Uint8Array(await file.arrayBuffer()),
            });
          });
        },
      };
    },
  };
}

function queue(
  delivery: ValueStorage<Promise<void>>,
  events: EventStorage<MessagingEvent>,
  send: () => Promise<void>,
): void {
  delivery.put(deliverAfter(delivery.get(), events, send));
}

async function deliverAfter(
  previous: Promise<void> | undefined,
  events: EventStorage<MessagingEvent>,
  send: () => Promise<void>,
): Promise<void> {
  try {
    await previous;
    await send();
  } catch (reason) {
    events.append({ type: "failed", error: errorMessage(reason) });
  }
}

function requireText(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Enter a message.");
  }
}

function requireFile(value: unknown): TransferredFile {
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

function isByteArray(value: unknown): value is Uint8Array {
  return Object.prototype.toString.call(value) === "[object Uint8Array]";
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message.length > 0) return reason.message;
  if (typeof reason === "string" && reason.length > 0) return reason;
  return "Message delivery failed.";
}
