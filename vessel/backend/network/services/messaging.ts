import type { Peer, PromisedMethods } from "@c/backend/network";
import type { Session } from "@v/backend/session";
import type { Channel } from "@v/backend/signals";

export const messagingServiceName = "messaging";

type MessageContent = Readonly<
  { type: "text"; text: string } | { type: "file"; file: File }
>;

export type MessagingEvent = Readonly<
  | { peerId: string; type: "sent"; content: MessageContent }
  | { peerId: string; type: "received"; content: MessageContent }
  | { peerId: string; type: "failed"; error: string }
>;

export interface MessagingRead {
  readonly peerId: string;
  readonly count: number;
}

export interface Messaging {
  readonly events: Channel<MessagingEvent>;
  readonly reads: Channel<MessagingRead>;
  history(peerId: string): readonly MessagingEvent[];
  readCount(peerId: string): number;
  markRead(peerId: string): void;
  sendText(peer: Peer, text: string): void;
  sendFile(peer: Peer, file: File): void;
}

interface TransferredFile {
  readonly name: string;
  readonly mediaType: string;
  readonly data: Uint8Array;
}

interface MessagingRpc {
  sendText(text: string): void;
  sendFile(file: TransferredFile): void;
}

export async function createMessaging(session: Session): Promise<Messaging> {
  const signals = session.signals();
  const storage = session.storage();
  const owner = Object.freeze({});
  const events = signals.channel<MessagingEvent>(owner, "events");
  const reads = signals.channel<MessagingRead>(owner, "reads");
  const hosted = new WeakSet<Peer>();
  const network = await session.network();

  function peerEvents(peerId: string) {
    return storage.peer(peerId).service(messagingServiceName).event<MessagingEvent>();
  }

  function readStorage(peerId: string) {
    return storage.peer(peerId).service(messagingServiceName).singleton<number>("read");
  }

  function retain(event: MessagingEvent): void {
    peerEvents(event.peerId).append(event);
    events.publish(event);
  }

  function fail(peerId: string, reason: unknown): void {
    retain({
      peerId,
      type: "failed",
      error: deliveryError(reason),
    });
  }

  function deliver(
    peer: Peer,
    content: MessageContent,
    send: (remote: PromisedMethods<MessagingRpc>) => Promise<void>,
  ): void {
    retain({ peerId: peer.id, type: "sent", content });
    const remote = peer.service<MessagingRpc>(messagingServiceName);
    void send(remote).catch((reason) => fail(peer.id, reason));
  }

  function receive(peerId: string): MessagingRpc {
    return {
      sendText(value) {
        const text = validateMessageText(value);
        retain({
          peerId,
          type: "received",
          content: { type: "text", text },
        });
      },
      sendFile(value) {
        const file = validateTransferredFile(value);
        retain({
          peerId,
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

  function host(peer: Peer): void {
    if (hosted.has(peer)) return;
    peer.host(messagingServiceName, receive(peer.id));
    hosted.add(peer);
  }

  network.subscribe((peer, event) => {
    if (event === "connected") host(peer);
  });
  network.connectedPeers().forEach(host);

  return {
    events,
    reads,
    history: (peerId) => peerEvents(peerId).read(),
    readCount: (peerId) => readStorage(peerId).get() ?? 0,
    markRead(peerId) {
      const count = peerEvents(peerId).read()
        .filter((event) => event.type === "received").length;
      readStorage(peerId).put(count);
      reads.publish({ peerId, count });
    },
    sendText(peer, value) {
      const text = validateMessageText(value);
      deliver(peer, { type: "text", text }, async (remote) => {
        await remote.sendText(text);
      });
    },
    sendFile(peer, file) {
      deliver(peer, { type: "file", file }, async (remote) => {
        await remote.sendFile(await transferFile(file));
      });
    },
  };
}

function validateMessageText(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Enter a message.");
  }
  return value;
}

async function transferFile(file: File): Promise<TransferredFile> {
  return {
    name: file.name,
    mediaType: file.type || "application/octet-stream",
    data: new Uint8Array(await file.arrayBuffer()),
  };
}

function deliveryError(reason: unknown): string {
  if (reason instanceof Error && reason.message.length > 0) return reason.message;
  if (typeof reason === "string" && reason.length > 0) return reason;
  return "Message delivery failed.";
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

function isByteArray(value: unknown): value is Uint8Array {
  return Object.prototype.toString.call(value) === "[object Uint8Array]";
}
