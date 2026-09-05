import signals from "@c/backend/signals";
import type { Subscription } from "@c/backend/signals";
import type { Call } from "./call";
import type { Chat } from "./chat";
import type { Roster } from "./roster";

// What is waiting for a reader, wherever they are: the StatusBar carries it into
// every view, and Home's rows mark the peer it waits on, so it is gathered once
// rather than counted again by each view.
export interface Notification {
  readonly peerId: string;
  readonly name: string;
  readonly unread: boolean;
  /** A call in progress with this peer: waiting to be answered, or already running. */
  readonly call?: "incoming" | "ongoing";
  /** What opening it leads to, attached by whoever owns navigation. */
  readonly onClick?: () => void;
}

export interface Notifications {
  readonly updates: Subscription<readonly Notification[]>;
  list(): readonly Notification[];
}

export function createNotifications(
  sources: { readonly chat: Chat; readonly call: Call; readonly roster: Roster },
): Notifications {
  const { chat, call, roster } = sources;
  const updates = signals.channel<readonly Notification[]>();
  let current: readonly Notification[] = [];

  function unread(peerId: string): boolean {
    const received = chat.history(peerId)
      .filter((item) => item.direction === "received").length;
    return received > chat.readCount(peerId);
  }

  // A finished call is not waiting for anything; an unanswered incoming one is,
  // and a running one is the way back to a call a reader navigated away from.
  function calling(): { peerId: string; mode: "incoming" | "ongoing" } | undefined {
    const state = call.current();
    if (state === undefined || state.status === "ended") return undefined;
    const incoming = state.status === "pending" && state.direction === "incoming";
    return { peerId: state.peerId, mode: incoming ? "incoming" : "ongoing" };
  }

  function gather(): readonly Notification[] {
    const active = calling();
    const waiting = roster.list().flatMap((entry): Notification[] => {
      const waiting = unread(entry.peerId);
      const mode = active?.peerId === entry.peerId ? active.mode : undefined;
      if (!waiting && mode === undefined) return [];
      return [{
        peerId: entry.peerId,
        name: entry.name,
        unread: waiting,
        ...(mode === undefined ? {} : { call: mode }),
      }];
    });
    // A call from a peer the Roster does not hold still has to reach the reader.
    if (active !== undefined && !waiting.some(({ peerId }) => peerId === active.peerId)) {
      waiting.push({
        peerId: active.peerId,
        name: roster.get(active.peerId)?.name ?? active.peerId,
        unread: false,
        call: active.mode,
      });
    }
    return Object.freeze(waiting);
  }

  function refresh(): void {
    const next = gather();
    if (unchanged(current, next)) return;
    current = next;
    updates.publish(next);
  }

  chat.updates.subscribe(refresh);
  chat.reads.subscribe(refresh);
  call.updates.subscribe(refresh);
  roster.updates.subscribe(refresh);
  current = gather();

  return { updates, list: () => current };
}

function unchanged(
  before: readonly Notification[],
  after: readonly Notification[],
): boolean {
  return before.length === after.length &&
    before.every((held, position) => {
      const next = after[position]!;
      return held.peerId === next.peerId && held.name === next.name &&
        held.unread === next.unread && held.call === next.call;
    });
}
