import type { RPC } from "@c/backend/network";
import signals from "@c/backend/signals";
import type { Channel, Subscription } from "@c/backend/signals";

export const callingServiceName = "calling";

// How a call finished, as its far side reports it. A closed set keeps the words a
// reader sees local, rather than showing text a peer chose.
export type CallEnding = "declined" | "busy" | "ended";

export type CallSignal = Readonly<
  | { type: "invited"; sdp: string }
  | { type: "accepted"; sdp: string }
  | { type: "candidate"; candidate: RTCIceCandidateInit }
  | { type: "ended"; reason: CallEnding }
>;

type Remote = {
  invite(sdp: string): void;
  accept(sdp: string): void;
  candidate(candidate: RTCIceCandidateInit): void;
  end(reason: CallEnding): void;
};

export type CallingService = {
  readonly remote: RPC<Remote>;
  readonly events: Subscription<CallSignal>;
};

// Media travels over a peer connection of its own, because the one libp2p holds
// carries data channels alone and cannot be renegotiated. This service carries
// what the two sides need to establish that second connection.
export function createCalling(): {
  readonly remote: Remote;
  readonly events: Channel<CallSignal>;
} {
  const events = signals.channel<CallSignal>();

  return {
    remote: {
      invite(sdp) {
        events.publish({ type: "invited", sdp: validateDescription(sdp) });
      },
      accept(sdp) {
        events.publish({ type: "accepted", sdp: validateDescription(sdp) });
      },
      candidate(candidate) {
        events.publish({ type: "candidate", candidate: validateCandidate(candidate) });
      },
      end(reason) {
        events.publish({ type: "ended", reason: validateEnding(reason) });
      },
    },
    events,
  };
}

function validateDescription(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Peer sent an invalid call description.");
  }
  return value;
}

// The peer sends what its browser produced, and only the fields which place a
// candidate in the description are carried across.
function validateCandidate(value: unknown): RTCIceCandidateInit {
  if (
    typeof value !== "object" ||
    value === null ||
    !("candidate" in value) ||
    typeof value.candidate !== "string" ||
    !("sdpMid" in value) ||
    !("sdpMLineIndex" in value) ||
    !isOptional(value.sdpMid, "string") ||
    !isOptional(value.sdpMLineIndex, "number")
  ) {
    throw new Error("Peer sent an invalid call address candidate.");
  }
  return Object.freeze({
    candidate: value.candidate,
    sdpMid: value.sdpMid as string | null,
    sdpMLineIndex: value.sdpMLineIndex as number | null,
  });
}

function validateEnding(value: unknown): CallEnding {
  if (value !== "declined" && value !== "busy" && value !== "ended") {
    throw new Error("Peer sent an invalid call ending.");
  }
  return value;
}

function isOptional(value: unknown, type: "string" | "number"): boolean {
  return value === null || value === undefined || typeof value === type;
}
