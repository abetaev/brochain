import type { RPC } from "@c/backend/network";
import signals from "@c/backend/signals";
import type { Channel, Subscription } from "@c/backend/signals";

export const messagingServiceName = "messaging";

export interface ReceivedMessage {
  readonly message: string;
}

type Remote = {
  send(message: string): void;
};

export type MessagingService = {
  readonly remote: RPC<Remote>;
  readonly events: Subscription<ReceivedMessage>;
};

export function createMessaging(): {
  readonly remote: Remote;
  readonly events: Channel<ReceivedMessage>;
} {
  const events = signals.channel<ReceivedMessage>();

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
