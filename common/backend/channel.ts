export interface Channel<Event> {
  publish(event: Event): void;
  subscribe(listener: (event: Event) => unknown): () => void;
}

export function createChannel<Event>(): Channel<Event> {
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
