import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createSignals } from "./signals.ts";

describe("Signals", () => {
  it("returns one typed Channel for an owner and local name", () => {
    const signals = createSignals();
    const owner = {};
    const first = signals.channel<{ readonly value: number }>(owner, "updates");
    const second = signals.channel<{ readonly value: number }>(owner, "updates");

    expect(first).toBe(second);
    expectTypeOf(first.publish).parameter(0).toEqualTypeOf<{
      readonly value: number;
    }>();
    expectTypeOf(first.subscribe).parameter(0).returns.toEqualTypeOf<unknown>();
  });

  it("isolates owner namespaces and Signals instances", () => {
    const firstSignals = createSignals();
    const secondSignals = createSignals();
    const firstOwner = {};
    const secondOwner = {};
    const first = firstSignals.channel<number>(firstOwner, "updates");
    const otherName = firstSignals.channel<number>(firstOwner, "other");
    const otherOwner = firstSignals.channel<number>(secondOwner, "updates");
    const otherSignals = secondSignals.channel<number>(firstOwner, "updates");
    const listener = vi.fn();

    otherName.subscribe(listener);
    otherOwner.subscribe(listener);
    otherSignals.subscribe(listener);
    first.publish(1);

    expect(listener).not.toHaveBeenCalled();
    expect(first).not.toBe(otherName);
    expect(first).not.toBe(otherOwner);
    expect(first).not.toBe(otherSignals);
  });

  it("delivers synchronously in subscription order without replay", () => {
    const channel = createSignals().channel<number>({}, "updates");
    const received: string[] = [];

    channel.publish(0);
    channel.subscribe((value) => received.push(`first:${value}`));
    channel.subscribe((value) => received.push(`second:${value}`));
    channel.publish(1);

    expect(received).toEqual(["first:1", "second:1"]);
  });

  it("keeps duplicate subscriptions independent and stops each idempotently", () => {
    const channel = createSignals().channel<number>({}, "updates");
    const listener = vi.fn();
    const stopFirst = channel.subscribe(listener);
    const stopSecond = channel.subscribe(listener);

    channel.publish(1);
    stopFirst();
    stopFirst();
    channel.publish(2);
    stopSecond();
    channel.publish(3);

    expect(listener.mock.calls).toEqual([[1], [1], [2]]);
  });

  it("logs and isolates subscriber failures", () => {
    const channel = createSignals().channel<void>({}, "updates");
    const privatePayload = { message: "private event data" };
    const later = vi.fn();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      channel.subscribe(() => {
        throw privatePayload;
      });
      channel.subscribe(() => {
        later();
        return "ignored";
      });

      expect(() => channel.publish(undefined)).not.toThrow();
      expect(later).toHaveBeenCalledOnce();
      expect(logged.mock.calls).toEqual([["Channel subscriber failed."]]);
    } finally {
      logged.mockRestore();
    }
  });
});
