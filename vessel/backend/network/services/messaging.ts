import type { Peer, PromisedMethods } from "@c/backend/network";
import type { Session } from "@v/backend/session";
import type { Channel } from "@v/backend/signals";
import { isServiceEnabled } from "@v/backend/options/network-services";

export const messagingServiceName = "messaging";

export interface TextMessage {
  readonly id: string;
  readonly text: string;
}

export type MessagingEvent = Readonly<
  | { peerId: string; type: "sent"; message: TextMessage }
  | { peerId: string; type: "received"; message: TextMessage }
  | { peerId: string; type: "failed"; message: TextMessage; error: string }
>;

export interface Messaging {
  readonly events: Channel<MessagingEvent>;
  send(peer: Peer, message: TextMessage): void;
}

interface MessagingRpc {
  send(message: TextMessage): void;
}

export async function createMessaging(session: Session): Promise<Messaging> {
  const events = session.signals().channel<MessagingEvent>({}, "events");
  const options = session.options();
  const network = await session.network();

  await network.provide({
    [messagingServiceName]: {
      enabled: (peer) => isServiceEnabled(
        options,
        peer.id,
        messagingServiceName,
      ),
      rpc: (peer) => receive(peer.id),
    },
  });

  function receive(peerId: string): MessagingRpc {
    return {
      send(value) {
        events.publish({
          peerId,
          type: "received",
          message: validateMessage(value),
        });
      },
    };
  }

  return {
    events,
    send(peer, value) {
      const message = validateMessage(value);
      events.publish({ peerId: peer.id, type: "sent", message });
      const remote = peer.service<MessagingRpc>(messagingServiceName);
      void deliver(remote, message).catch((reason) => {
        events.publish({
          peerId: peer.id,
          type: "failed",
          message,
          error: deliveryError(reason),
        });
      });
    },
  };
}

async function deliver(
  remote: PromisedMethods<MessagingRpc>,
  message: TextMessage,
): Promise<void> {
  await remote.send(message);
}

function validateMessage(value: unknown): TextMessage {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 128 ||
    !("text" in value) ||
    typeof value.text !== "string" ||
    value.text.trim().length === 0
  ) {
    throw new Error("Peer sent an invalid text message.");
  }
  return { id: value.id, text: value.text };
}

function deliveryError(reason: unknown): string {
  if (reason instanceof Error && reason.message.length > 0) return reason.message;
  if (typeof reason === "string" && reason.length > 0) return reason;
  return "Message delivery failed.";
}
