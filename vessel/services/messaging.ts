import type { Peer } from "../../common/network.ts";
import type { PeerService } from "../../common/rpc.ts";
import type { StorageFactory } from "../storage";

type MessageContent = Readonly<
  { type: "text"; text: string } | { type: "file"; file: File }
>;

export type MessagingEvent = Readonly<
  | { type: "sent"; content: MessageContent }
  | { type: "received"; content: MessageContent }
  | { type: "failed"; error: string }
>;

interface PeerMessaging {
  sendText(text: string): void;
  sendFile(file: File): void;
  subscribe(listener: (events: readonly MessagingEvent[]) => void): () => void;
}

const serviceName = "messaging";

interface MessagingService extends PeerService<typeof serviceName> {
  sendText(text: string): void;
  sendFile(file: {
    readonly name: string;
    readonly mediaType: string;
    readonly data: Uint8Array;
  }): void;
}

export function createMessaging(storage: StorageFactory) {
  const deliveries = new Map<string, Promise<void>>();

  return {
    serve(peer: Peer): MessagingService {
      const events = storage.events<MessagingEvent>(peer.id, serviceName);

      return {
        name: serviceName,
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
    instance(peer: Peer): PeerMessaging {
      const events = storage.events<MessagingEvent>(peer.id, serviceName);
      const remote = peer.service<MessagingService>(serviceName);

      return {
        sendText(text) {
          requireText(text);
          events.append({ type: "sent", content: { type: "text", text } });
          queue(peer.id, events, async () => await remote.sendText(text));
        },
        sendFile(file) {
          events.append({ type: "sent", content: { type: "file", file } });
          queue(peer.id, events, async () => {
            await remote.sendFile({
              name: file.name,
              mediaType: file.type || "application/octet-stream",
              data: new Uint8Array(await file.arrayBuffer()),
            });
          });
        },
        subscribe(listener) {
          listener(events.read());
          return events.subscribe(() => listener(events.read()));
        },
      };
    },
  };

  function queue(
    peerId: string,
    events: { append(event: MessagingEvent): void },
    send: () => Promise<void>,
  ): void {
    deliveries.set(
      peerId,
      deliverAfter(deliveries.get(peerId), events, send),
    );
  }
}

async function deliverAfter(
  previous: Promise<void> | undefined,
  events: { append(event: MessagingEvent): void },
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

function requireFile(value: unknown): {
  readonly name: string;
  readonly mediaType: string;
  readonly data: Uint8Array;
} {
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
