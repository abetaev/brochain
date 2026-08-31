import type { Peer } from "@c/backend/network";
import {
  dataTransferServiceName,
  type DataTransferEvent,
  type DataTransferService,
  type TransferMetadata,
} from "@v/backend/network/services/data-transfer";
import {
  messagingServiceName,
  type MessagingService,
} from "@v/backend/network/services/messaging";
import type { Session } from "@v/backend/session";
import type { Channel } from "@v/backend/signals";
import type { FileWriter, StoredFile } from "@v/backend/storage";

export interface ChatFile {
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  open(): Promise<File>;
}

interface ChatItemBase {
  readonly id: string;
  readonly peerId: string;
  readonly direction: "sent" | "received";
  readonly status: "transferring" | "complete" | "failed";
  readonly error?: string;
}

export type ChatItem = Readonly<
  | (ChatItemBase & { kind: "text"; text: string })
  | (ChatItemBase & {
    kind: "file";
    name: string;
    mediaType: string;
    size: number;
    transferred: number;
    file?: ChatFile;
  })
>;

export interface ChatRead {
  readonly peerId: string;
  readonly count: number;
}

export interface ChatCapabilities {
  readonly text: boolean;
  readonly files: boolean;
}

export interface Chat {
  readonly updates: Channel<ChatItem>;
  readonly reads: Channel<ChatRead>;
  capabilities(peer: Peer): ChatCapabilities;
  history(peerId: string): readonly ChatItem[];
  readCount(peerId: string): number;
  markRead(peerId: string): void;
  sendText(peer: Peer, text: string): void;
  sendFile(peer: Peer, file: File): void;
}

const chatServiceName = "chat";

export function createChat(session: Session): Chat {
  const signals = session.signals();
  const updates = signals.channel<ChatItem>({}, "updates");
  const reads = signals.channel<ChatRead>({}, "reads");
  const incomingWriters = new Map<string, FileWriter>();
  const network = session.network();
  const serviceSubscriptions = new Map<string, readonly (() => void)[]>();

  function attach(peer: Peer): void {
    for (const stop of serviceSubscriptions.get(peer.id) ?? []) stop();
    const services = peer.services();
    const subscriptions: (() => void)[] = [];
    if (services.includes(messagingServiceName)) {
      subscriptions.push(peer.service<MessagingService>(messagingServiceName)
        .events.subscribe(({ message }) => receiveMessage(peer.id, message)));
    }
    if (services.includes(dataTransferServiceName)) {
      subscriptions.push(peer.service<DataTransferService>(dataTransferServiceName)
        .events.subscribe(receiveTransfer));
    }
    serviceSubscriptions.set(peer.id, subscriptions);
  }

  for (const peer of network.connectedPeers()) attach(peer);
  network.updates.subscribe((update) => {
    if (update.type === "remove") {
      for (const stop of serviceSubscriptions.get(update.peerId) ?? []) stop();
      serviceSubscriptions.delete(update.peerId);
    } else if (update.changed === "connection" || update.changed === "publication") {
      attach(update.peer);
    }
  });

  function itemStorage(peerId: string) {
    return session.storage().peer(peerId).service(chatServiceName).kv<ChatItem>("items");
  }

  function orderStorage(peerId: string) {
    return session.storage().peer(peerId).service(chatServiceName).event<string>("order");
  }

  function readStorage(peerId: string) {
    return session.storage().peer(peerId).service(chatServiceName).singleton<number>("read");
  }

  function fileStorage(peerId: string) {
    return session.storage().peer(peerId).service(chatServiceName).fs();
  }

  function history(peerId: string): readonly ChatItem[] {
    const items = itemStorage(peerId);
    return orderStorage(peerId).read().flatMap((id) => {
      const item = items.get(id);
      return item === undefined ? [] : [item];
    });
  }

  function retain(item: ChatItem): void {
    const items = itemStorage(item.peerId);
    if (items.get(item.id) !== undefined) {
      throw new Error("A peer reused an existing chat item identifier.");
    }
    orderStorage(item.peerId).append(item.id);
    items.put(item.id, item);
    updates.publish(item);
  }

  function update(item: ChatItem): void {
    const items = itemStorage(item.peerId);
    if (items.get(item.id) === undefined) return;
    items.put(item.id, item);
    updates.publish(item);
  }

  function current(peerId: string, id: string): ChatItem | undefined {
    return itemStorage(peerId).get(id);
  }

  function receiveMessage(peerId: string, text: string): void {
    retain({
      id: crypto.randomUUID(),
      peerId,
      direction: "received",
      kind: "text",
      text,
      status: "complete",
    });
  }

  function receiveTransfer(event: DataTransferEvent): void {
    if (event.type === "offered") {
      if (current(event.peerId, event.id) !== undefined) {
        event.reject("A peer reused an existing chat item identifier.");
        return;
      }
      let file: ReturnType<typeof validateFileMetadata>;
      try {
        file = validateFileMetadata(event.metadata, event.size);
      } catch (reason) {
        event.reject(errorMessage(reason));
        return;
      }
      retain({
        id: event.id,
        peerId: event.peerId,
        direction: "received",
        kind: "file",
        ...file,
        transferred: 0,
        status: "transferring",
      });
      const writer = fileStorage(event.peerId).create(event.size).then((created) => {
        incomingWriters.set(transferKey(event.peerId, event.id), created);
        return created;
      });
      event.accept(writer);
      return;
    }

    const item = current(event.peerId, event.id);
    if (item?.kind !== "file") return;
    if (event.type === "progress") {
      update({ ...item, transferred: event.transferred });
      return;
    }
    if (event.type === "failed") {
      incomingWriters.delete(transferKey(event.peerId, event.id));
      update({ ...item, status: "failed", error: event.error });
      return;
    }

    if (event.direction === "received") {
      const writer = incomingWriters.get(transferKey(event.peerId, event.id));
      incomingWriters.delete(transferKey(event.peerId, event.id));
      if (writer === undefined) {
        update({ ...item, status: "failed", error: "Received data is unavailable." });
        return;
      }
      update({
        ...item,
        transferred: item.size,
        status: "complete",
        file: storedFile(writer.file, item.name, item.mediaType, item.size),
      });
      return;
    }
    update({ ...item, transferred: item.size, status: "complete" });
  }

  return {
    updates,
    reads,
    capabilities(peer) {
      if (!peer.isConnected()) return { text: false, files: false };
      const services = peer.services();
      return {
        text: services.includes(messagingServiceName),
        files: services.includes(dataTransferServiceName),
      };
    },
    history,
    readCount: (peerId) => readStorage(peerId).get() ?? 0,
    markRead(peerId) {
      const count = history(peerId).filter((item) => item.direction === "received").length;
      readStorage(peerId).put(count);
      reads.publish({ peerId, count });
    },
    sendText(peer, value) {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error("Enter a message.");
      }
      if (!peer.services().includes(messagingServiceName)) {
        throw new Error("Messaging is unavailable.");
      }
      const id = crypto.randomUUID();
      retain({
        id,
        peerId: peer.id,
        direction: "sent",
        kind: "text",
        text: value,
        status: "complete",
      });
      void peer.service<MessagingService>(messagingServiceName).remote.send(value)
        .catch((reason: unknown) => {
          const item = current(peer.id, id);
          if (item?.kind === "text") {
            update({ ...item, status: "failed", error: errorMessage(reason) });
          }
        });
    },
    sendFile(peer, file) {
      if (!(file instanceof File)) throw new Error("Select a file to send.");
      const id = crypto.randomUUID();
      const mediaType = file.type || "application/octet-stream";
      retain({
        id,
        peerId: peer.id,
        direction: "sent",
        kind: "file",
        name: file.name,
        mediaType,
        size: file.size,
        transferred: 0,
        status: "transferring",
        file: browserFile(file),
      });
      try {
        const transfers = peer.service<DataTransferService>(dataTransferServiceName);
        if (!peer.services().includes(dataTransferServiceName) || transfers.send === undefined) {
          throw new Error("Data transfer is unavailable.");
        }
        transfers.send({
          id,
          size: file.size,
          metadata: {
            kind: "chat-file",
            name: file.name,
            mediaType,
          },
          data: file.stream(),
        });
      } catch (reason) {
        const item = current(peer.id, id);
        if (item?.kind === "file") {
          update({ ...item, status: "failed", error: errorMessage(reason) });
        }
        throw reason;
      }
    },
  };
}

function validateFileMetadata(
  metadata: TransferMetadata,
  size: number,
): { readonly name: string; readonly mediaType: string; readonly size: number } {
  if (
    metadata.kind !== "chat-file" ||
    typeof metadata.name !== "string" ||
    metadata.name.length === 0 ||
    metadata.name.length > 255 ||
    typeof metadata.mediaType !== "string" ||
    metadata.mediaType.length > 255
  ) {
    throw new Error("Peer sent invalid Chat file metadata.");
  }
  return { name: metadata.name, mediaType: metadata.mediaType, size };
}

function browserFile(file: File): ChatFile {
  return {
    name: file.name,
    mediaType: file.type || "application/octet-stream",
    size: file.size,
    open: async () => file,
  };
}

function storedFile(
  file: StoredFile,
  name: string,
  mediaType: string,
  size: number,
): ChatFile {
  return {
    name,
    mediaType,
    size,
    open: async () => new File([await file.blob()], name, { type: mediaType }),
  };
}

function transferKey(peerId: string, id: string): string {
  return `${peerId}\n${id}`;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error && reason.message.length > 0
    ? reason.message
    : "Chat operation failed.";
}
