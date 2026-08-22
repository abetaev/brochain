import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import type { PromisedMethods } from "@c/backend/network";
import {
  registryServiceName,
  validateServiceNames,
  type Registry,
} from "@c/backend/network/services/registry";
import {
  identityServiceName,
  loadContact,
  type IdentityService,
} from "@v/backend/network/services/identity";
import {
  messageDeliveryError,
  messagingServiceName,
  transferFile,
  validateMessageText,
  type MessageContent,
  type MessagingEvent,
  type MessagingService,
} from "@v/backend/network/services/messaging";
import type { Session } from "@v/backend/session";
import type { EventStorage } from "@v/backend/storage";
import type { Roster } from "@v/frontend/services/roster";

interface Channel {
  readonly remote: PromisedMethods<MessagingService>;
  readonly events: EventStorage<MessagingEvent>;
}

export function Chat(props: {
  session: Session;
  roster: Roster;
  peerId: string;
  onBack(): void;
}) {
  const [name, setName] = createSignal(props.peerId);
  const [events, setEvents] = createSignal<readonly MessagingEvent[]>([]);
  const [error, setError] = createSignal<string>();
  const [channel, setChannel] = createSignal<Channel>();
  const downloadUrls = new Map<File, string>();
  let stopEvents: (() => void) | undefined;
  let active = true;

  function deliver(
    content: MessageContent,
    send: (remote: PromisedMethods<MessagingService>) => Promise<void>,
  ): void {
    const current = channel();
    if (current === undefined) throw new Error("Messaging is not ready.");
    current.events.append({ type: "sent", content });
    void send(current.remote).catch((reason) => {
      current.events.append({ type: "failed", error: messageDeliveryError(reason) });
    });
  }

  function attemptSend(operation: () => void): void {
    setError(undefined);
    try {
      operation();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  function sendText(
    event: SubmitEvent & { currentTarget: HTMLFormElement },
  ): void {
    event.preventDefault();
    const form = event.currentTarget;
    attemptSend(() => {
      const text = validateMessageText(
        String(new FormData(form).get("message") ?? ""),
      );
      deliver({ type: "text", text }, async (remote) => await remote.sendText(text));
      form.reset();
    });
  }

  function sendFile(event: Event & { currentTarget: HTMLInputElement }): void {
    const file = event.currentTarget.files?.[0];
    if (file === undefined) return;
    attemptSend(() => {
      deliver(
        { type: "file", file },
        async (remote) => await remote.sendFile(await transferFile(file)),
      );
      event.currentTarget.value = "";
    });
  }

  async function initialize(): Promise<void> {
    try {
      const peer = await props.roster.getPeer(props.peerId);
      if (peer === undefined) throw new Error("This peer is no longer available.");
      if (!peer.isConnected()) throw new Error("This peer is not connected.");

      const services = validateServiceNames(
        await peer.service<Registry>(registryServiceName).list(),
      );
      if (!services.includes(messagingServiceName)) {
        throw new Error("This peer does not provide messaging.");
      }
      if (!active) return;

      const peerStorage = props.session.storage().peer(peer.id);
      const serviceStorage = peerStorage.service(messagingServiceName);
      const messageEvents = serviceStorage.event<MessagingEvent>();
      const read = serviceStorage.singleton<number>("read");
      const update = () => {
        const snapshot = messageEvents.read();
        setEvents(snapshot);
        read.put(snapshot.filter((event) => event.type === "received").length);
      };
      stopEvents = messageEvents.subscribe(update);
      update();
      setChannel({
        remote: peer.service<MessagingService>(messagingServiceName),
        events: messageEvents,
      });

      if (services.includes(identityServiceName)) {
        try {
          const contact = await loadContact(
            peer.service<IdentityService>(identityServiceName),
            peerStorage.service(identityServiceName),
          );
          if (active) setName(contact.name);
        } catch {
          // A peer id is always available as the display fallback.
        }
      }
    } catch (reason) {
      if (active) setError(errorMessage(reason));
    }
  }

  function downloadUrl(file: File): string {
    const existing = downloadUrls.get(file);
    if (existing !== undefined) return existing;
    const created = URL.createObjectURL(file);
    downloadUrls.set(file, created);
    return created;
  }

  onMount(() => void initialize());
  onCleanup(() => {
    active = false;
    stopEvents?.();
    for (const url of downloadUrls.values()) URL.revokeObjectURL(url);
  });

  return (
    <section aria-labelledby="chat-heading">
      <header>
        <button class="secondary" type="button" onClick={props.onBack}>Back to Home</button>
        <h2 id="chat-heading">Chat with {name()}</h2>
      </header>
      <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
      <For each={events()}>
        {(event) => event.type === "failed" ? (
          <p role="alert">{event.error}</p>
        ) : (
          <article>
            <header>{event.type === "sent" ? "You" : name()}</header>
            {event.content.type === "text" ? (
              <p>{event.content.text}</p>
            ) : (
              <p>
                <a download={event.content.file.name} href={downloadUrl(event.content.file)}>
                  Download {event.content.file.name}
                </a>
              </p>
            )}
          </article>
        )}
      </For>
      <form onSubmit={sendText}>
        <label for="message">
          Message
          <input id="message" name="message" required disabled={channel() === undefined} />
        </label>
        <button type="submit" disabled={channel() === undefined}>Send message</button>
      </form>
      <label for="file">
        Send a file
        <input
          id="file"
          type="file"
          disabled={channel() === undefined}
          onChange={sendFile}
        />
      </label>
    </section>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "An unexpected chat error occurred.";
}
