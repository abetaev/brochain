import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import {
  registryServiceName,
  validateServiceNames,
  type Peer,
  type PromisedMethods,
  type Registry,
} from "../../common/services/network/index.ts";
import {
  identityServiceName,
  validateContact,
  type Contact,
  type IdentityService,
} from "@/services/network/services/identity";
import {
  messageDeliveryError,
  messagingServiceName,
  transferFile,
  validateMessageText,
  type MessagingEvent,
  type MessagingService,
} from "@/services/network/services/messaging";
import type { EventStorage } from "@/services/storage";
import type { Session } from "@/session";

export function Chat(props: {
  session: Session;
  peerId: string;
  onBack(): void;
}) {
  const [name, setName] = createSignal(props.peerId);
  const [events, setEvents] = createSignal<readonly MessagingEvent[]>([]);
  const [error, setError] = createSignal<string>();
  const [ready, setReady] = createSignal(false);
  const downloadUrls = new Map<File, string>();
  let messageInput: HTMLInputElement | undefined;
  let messaging: PromisedMethods<MessagingService> | undefined;
  let messageEvents: EventStorage<MessagingEvent> | undefined;
  let stopEvents: (() => void) | undefined;
  let active = true;

  function update(peer: Peer): void {
    const storage = props.session.storage().peer(peer.id).service(messagingServiceName);
    const snapshot = storage.event<MessagingEvent>().read();
    setEvents(snapshot);
    storage.singleton<number>("read").put(
      snapshot.filter((event) => event.type === "received").length,
    );
  }

  function sendText(event: SubmitEvent): void {
    event.preventDefault();
    setError(undefined);
    try {
      const remote = messaging;
      const storage = messageEvents;
      if (remote === undefined || storage === undefined) {
        throw new Error("Messaging is not ready.");
      }
      const text = validateMessageText(messageInput?.value ?? "");
      storage.append({ type: "sent", content: { type: "text", text } });
      void remote.sendText(text).catch((reason) => {
        storage.append({ type: "failed", error: messageDeliveryError(reason) });
      });
      if (messageInput !== undefined) messageInput.value = "";
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  function sendFile(event: Event & { currentTarget: HTMLInputElement }): void {
    const file = event.currentTarget.files?.[0];
    if (file === undefined) return;
    setError(undefined);
    try {
      const remote = messaging;
      const storage = messageEvents;
      if (remote === undefined || storage === undefined) {
        throw new Error("Messaging is not ready.");
      }
      storage.append({ type: "sent", content: { type: "file", file } });
      void (async () => {
        try {
          await remote.sendFile(await transferFile(file));
        } catch (reason) {
          storage.append({ type: "failed", error: messageDeliveryError(reason) });
        }
      })();
      event.currentTarget.value = "";
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function initialize(): Promise<void> {
    try {
      const roster = await props.session.roster();
      const peer = await roster.getPeer(props.peerId);
      if (peer === undefined) throw new Error("This peer is no longer available.");
      if (!peer.isConnected()) throw new Error("This peer is not connected.");

      const services = validateServiceNames(
        await peer.service<Registry>(registryServiceName).list(),
      );
      if (!services.includes(messagingServiceName)) {
        throw new Error("This peer does not provide messaging.");
      }
      if (!active) return;

      messaging = peer.service<MessagingService>(messagingServiceName);
      const eventStorage = props.session.storage().peer(peer.id)
        .service(messagingServiceName).event<MessagingEvent>();
      messageEvents = eventStorage;
      update(peer);
      stopEvents = eventStorage.subscribe(() => update(peer));
      setReady(true);

      if (services.includes(identityServiceName)) {
        try {
          const contact = props.session.storage().peer(peer.id)
            .service(identityServiceName).singleton<Contact>();
          let identity = contact.get();
          if (identity === undefined) {
            identity = validateContact(
              await peer.service<IdentityService>(identityServiceName).get(),
            );
            contact.put(identity);
          }
          if (active) setName(identity.name);
        } catch {
          // A peer id is always available as the display fallback.
        }
      }
    } catch (reason) {
      if (active) setError(errorMessage(reason));
    }
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
                <a
                  download={event.content.file.name}
                  href={downloadUrl(event.content.file, downloadUrls)}
                >
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
          <input id="message" ref={messageInput} required disabled={!ready()} />
        </label>
        <button type="submit" disabled={!ready()}>Send message</button>
      </form>
      <label for="file">
        Send a file
        <input id="file" type="file" disabled={!ready()} onChange={sendFile} />
      </label>
    </section>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "An unexpected chat error occurred.";
}

function downloadUrl(file: File, urls: Map<File, string>): string {
  const existing = urls.get(file);
  if (existing !== undefined) return existing;
  const created = URL.createObjectURL(file);
  urls.set(file, created);
  return created;
}
