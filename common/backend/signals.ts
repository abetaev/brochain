// What a channel's owner hands to its consumers: they observe, only the owner publishes.
export interface Subscription<Event> {
  subscribe(listener: (event: Event) => unknown): () => void;
}

export interface Channel<Event> extends Subscription<Event> {
  publish(event: Event): void;
}

// The event bus. Every component which integrates through publish and subscribe
// takes its channels from here rather than building its own. It belongs to no
// owner: channels are independent, so one bus serves the whole application.
export interface Signals {
  channel<Event>(): Channel<Event>;
}

function createChannel<Event>(): Channel<Event> {
  const subscriptions: Array<{ readonly listener: (event: Event) => unknown }> = [];

  return Object.freeze({
    publish(event: Event) {
      for (const { listener } of [...subscriptions]) {
        try {
          listener(event);
        } catch {
          reportSubscriberFailure();
        }
      }
    },
    subscribe(listener: (event: Event) => unknown) {
      const subscription = { listener };
      subscriptions.push(subscription);
      let subscribed = true;

      return () => {
        if (!subscribed) return;
        subscribed = false;
        const index = subscriptions.indexOf(subscription);
        if (index >= 0) subscriptions.splice(index, 1);
      };
    },
  });
}

function reportSubscriberFailure(): void {
  try {
    console.error("Channel subscriber failed.");
  } catch {
    // Diagnostics must not allow one integration to affect another.
  }
}

const signals: Signals = { channel: createChannel };

export default signals;
