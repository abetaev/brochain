import { createChannel, type Channel } from "@c/backend/channel";
import type { RPC } from "@c/backend/network";

export const messagingServiceName = "messaging";

export interface ReceivedMessage {
  readonly message: string;
}

type Remote = {
  send(message: string): void;
};

export type MessagingService = {
  readonly remote: RPC<Remote>;
  readonly events: Channel<ReceivedMessage>;
};

export function createMessaging(): {
  readonly remote: Remote;
  readonly events: Channel<ReceivedMessage>;
} {
  const events = createChannel<ReceivedMessage>();

  return {
    remote: {
      send(message) {
        events.publish({ message: validateMessage(message) });
      },
    },
    events,
  };
}

function validateMessage(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Peer sent an invalid text message.");
  }
  return value;
}
