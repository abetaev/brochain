import { For, createSignal, onCleanup, onMount } from "solid-js";
import type { Peer } from "../../common/network.ts";
import type { MessagingEvent } from "@/services/messaging";
import type { Session } from "@/session";

export function Chat(props: {
  session: Session;
  peer: Peer;
  onRead(received: number): void;
  onBack(): void;
}) {
  const messaging = props.session.messaging.instance(props.peer);
  const [name, setName] = createSignal(props.peer.id);
  const [events, setEvents] = createSignal<readonly MessagingEvent[]>([]);
  const [error, setError] = createSignal<string>();
  const downloadUrls = new Map<File, string>();
  let messageInput: HTMLInputElement | undefined;

  function update(next: readonly MessagingEvent[]): void {
    setEvents(next);
    props.onRead(next.filter((event) => event.type === "received").length);
  }

  function sendText(event: SubmitEvent): void {
    event.preventDefault();
    try {
      messaging.sendText(messageInput?.value ?? "");
      if (messageInput !== undefined) messageInput.value = "";
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  function sendFile(event: Event & { currentTarget: HTMLInputElement }): void {
    const file = event.currentTarget.files?.[0];
    if (file === undefined) return;
    try {
      messaging.sendFile(file);
      event.currentTarget.value = "";
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function loadName(): Promise<void> {
    if (!props.peer.services.includes("identity")) return;
    try {
      setName((await props.session.identity.instance(props.peer).get()).name);
    } catch {
      // The peer id remains its display fallback.
    }
  }

  onMount(() => {
    const stop = messaging.subscribe(update);
    void loadName();
    onCleanup(stop);
  });

  onCleanup(() => {
    for (const url of downloadUrls.values()) URL.revokeObjectURL(url);
  });

  return (
    <section aria-labelledby="chat-heading">
      <header>
        <button class="secondary" type="button" onClick={props.onBack}>Back to Home</button>
        <h2 id="chat-heading">Chat with {name()}</h2>
      </header>
      {error() === undefined ? undefined : <p role="alert">{error()}</p>}
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
          <input id="message" ref={messageInput} required />
        </label>
        <button type="submit">Send message</button>
      </form>
      <label for="file">
        Send a file
        <input id="file" type="file" onChange={sendFile} />
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
