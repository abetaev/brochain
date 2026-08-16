import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import {
  registryServiceName,
  type Peer,
  type RegistryService,
} from "../../common/network/index.ts";
import {
  identityServiceName,
  type IdentityDefinition,
} from "@/network/services/identity";
import {
  messagingServiceName,
  type Messaging,
  type MessagingDefinition,
  type MessagingEvent,
} from "@/network/services/messaging";
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
  let messaging: Messaging | undefined;
  let stopEvents: (() => void) | undefined;
  let active = true;

  function update(peer: Peer): void {
    const storage = props.session.storage(peer);
    const snapshot = storage.events<MessagingEvent>(messagingServiceName).read();
    setEvents(snapshot);
    storage.value<number>(messagingServiceName, "read").put(
      snapshot.filter((event) => event.type === "received").length,
    );
  }

  function sendText(event: SubmitEvent): void {
    event.preventDefault();
    setError(undefined);
    try {
      if (messaging === undefined) throw new Error("Messaging is not ready.");
      messaging.sendText(messageInput?.value ?? "");
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
      if (messaging === undefined) throw new Error("Messaging is not ready.");
      messaging.sendFile(file);
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

      const services = await peer
        .service<RegistryService>(registryServiceName)
        .list();
      if (!services.includes(messagingServiceName)) {
        throw new Error("This peer does not provide messaging.");
      }
      if (!active) return;

      messaging = peer.service<MessagingDefinition>(messagingServiceName);
      const eventStorage = props.session.storage(peer)
        .events<MessagingEvent>(messagingServiceName);
      update(peer);
      stopEvents = eventStorage.subscribe(() => update(peer));
      setReady(true);

      if (services.includes(identityServiceName)) {
        try {
          const identity = await peer
            .service<IdentityDefinition>(identityServiceName)
            .get();
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
