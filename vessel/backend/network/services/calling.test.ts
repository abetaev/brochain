import { describe, expect, it } from "vitest";
import { createCalling, type CallSignal } from "./calling.ts";

describe("Calling", () => {
  it("publishes each signalling step a peer sends", () => {
    const calling = createCalling();
    const received: CallSignal[] = [];
    calling.events.subscribe((signal) => received.push(signal));

    calling.remote.invite("v=0 offer");
    calling.remote.accept("v=0 answer");
    calling.remote.candidate({ candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 });
    calling.remote.end("declined");

    expect(received).toEqual([
      { type: "invited", sdp: "v=0 offer" },
      { type: "accepted", sdp: "v=0 answer" },
      {
        type: "candidate",
        candidate: { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 },
      },
      { type: "ended", reason: "declined" },
    ]);
  });

  it("refuses signalling a peer malformed", () => {
    const calling = createCalling();
    const received: CallSignal[] = [];
    calling.events.subscribe((signal) => received.push(signal));

    expect(() => calling.remote.invite(" ")).toThrow("invalid call description");
    expect(() => calling.remote.accept(undefined as unknown as string))
      .toThrow("invalid call description");
    expect(() => calling.remote.end("hung up" as never)).toThrow("invalid call ending");

    for (
      const candidate of [
        { sdpMid: "0", sdpMLineIndex: 0 },
        { candidate: "candidate:1", sdpMid: "0" },
        { candidate: "candidate:1", sdpMid: 0, sdpMLineIndex: 0 },
        { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: "0" },
      ]
    ) {
      expect(() => calling.remote.candidate(candidate as never))
        .toThrow("invalid call address candidate");
    }

    expect(received).toEqual([]);
  });

  it("carries only the fields which place a candidate", () => {
    const calling = createCalling();
    const received: CallSignal[] = [];
    calling.events.subscribe((signal) => received.push(signal));

    calling.remote.candidate({
      candidate: "candidate:1",
      sdpMid: null,
      sdpMLineIndex: null,
      usernameFragment: "unused",
    });

    expect(received).toEqual([{
      type: "candidate",
      candidate: { candidate: "candidate:1", sdpMid: null, sdpMLineIndex: null },
    }]);
  });
});
