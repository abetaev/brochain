import { For, Show, createResource, createSignal, onCleanup, onMount } from "solid-js";
import type { Peer } from "@c/backend/network";
import type { Chat as ChatService, ChatFile, ChatItem } from "@v/frontend/services/chat";
import type { Roster } from "@v/frontend/services/roster";

export function Chat(props: {
  chat: ChatService;
  roster: Roster;
  peerId: string;
  onBack(): void;
}) {
  const [name, setName] = createSignal(props.peerId);
  const [items, setItems] = createSignal<readonly ChatItem[]>([]);
  const [error, setError] = createSignal<string>();
  const [peer, setPeer] = createSignal<Peer>();
  const [filesAvailable, setFilesAvailable] = createSignal(false);
  const receivedIds = new Set<string>();
  let active = true;

  const stopEvents = props.chat.updates.subscribe((item) => {
    const currentPeer = peer();
    if (currentPeer === undefined || item.peerId !== currentPeer.id) return;
    setItems((current) => replaceItem(current, item));
    if (item.direction === "received" && !receivedIds.has(item.id)) {
      receivedIds.add(item.id);
      props.chat.markRead(currentPeer.id);
    }
  });

  async function refreshName(): Promise<void> {
    try {
      const entry = await props.roster.get(props.peerId);
      if (active && entry !== undefined) setName(entry.name);
    } catch {
      // The last resolved name remains available when refresh fails.
    }
  }
  const stopRoster = props.roster.invalidations.subscribe(() => void refreshName());

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
      const current = peer();
      if (current === undefined) throw new Error("Chat is not ready.");
      props.chat.sendText(
        current,
        String(new FormData(form).get("message") ?? ""),
      );
      form.reset();
    });
  }

  function sendFile(event: Event & { currentTarget: HTMLInputElement }): void {
    const file = event.currentTarget.files?.[0];
    if (file === undefined) return;
    attemptSend(() => {
      const current = peer();
      if (current === undefined || !filesAvailable()) {
        throw new Error("Data transfer is not available.");
      }
      props.chat.sendFile(current, file);
      event.currentTarget.value = "";
    });
  }

  async function initialize(): Promise<void> {
    try {
      const entry = await props.roster.get(props.peerId);
      if (entry === undefined) throw new Error("This peer is no longer available.");
      if (!active) return;
      setName(entry.name);

      const peer = entry.peer;
      if (peer === undefined) throw new Error("This peer is not currently available.");
      if (!peer.isConnected()) throw new Error("This peer is not connected.");

      const capabilities = await props.chat.capabilities(peer);
      if (!capabilities.text) {
        throw new Error("This peer does not provide messaging.");
      }
      if (!active) return;

      const history = props.chat.history(peer.id);
      history.filter((item) => item.direction === "received")
        .forEach((item) => receivedIds.add(item.id));
      setItems(history);
      props.chat.markRead(peer.id);
      setPeer(peer);
      setFilesAvailable(capabilities.files);
    } catch (reason) {
      if (active) setError(errorMessage(reason));
    }
  }

  onMount(() => void initialize());
  onCleanup(() => {
    active = false;
    stopEvents();
    stopRoster();
  });

  return (
    <section aria-labelledby="chat-heading">
      <header>
        <button class="secondary" type="button" onClick={props.onBack}>Back to Home</button>
        <h2 id="chat-heading">Chat with {name()}</h2>
      </header>
      <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
      <For each={items()}>
        {(item) => (
          <article>
            <header>{item.direction === "sent" ? "You" : name()}</header>
            {item.kind === "text" ? (
              <p>{item.text}</p>
            ) : (
              <FileItem item={item} />
            )}
            <Show when={item.status === "failed"}>
              <p role="alert">{item.error ?? "Transfer failed."}</p>
            </Show>
          </article>
        )}
      </For>
      <form onSubmit={sendText}>
        <label for="message">
          Message
          <input
            id="message"
            name="message"
            required
            disabled={peer() === undefined}
          />
        </label>
        <button type="submit" disabled={peer() === undefined}>Send message</button>
      </form>
      <label for="file">
        Send a file
        <input
          id="file"
          type="file"
          disabled={peer() === undefined || !filesAvailable()}
          onChange={sendFile}
        />
      </label>
    </section>
  );
}

function FileItem(props: { item: ChatItem & { kind: "file" } }) {
  const percentage = () => props.item.size === 0
    ? 100
    : Math.floor(props.item.transferred * 100 / props.item.size);

  return (
    <Show
      when={props.item.status === "complete" && props.item.file}
      fallback={<p>{props.item.name}: {percentage()}%</p>}
    >
      {(file) => <FileDownload file={file()} />}
    </Show>
  );
}

function FileDownload(props: { file: ChatFile }) {
  let url: string | undefined;
  const [download] = createResource(async () => {
    url = URL.createObjectURL(await props.file.open());
    return url;
  });
  onCleanup(() => {
    if (url !== undefined) URL.revokeObjectURL(url);
  });

  return (
    <Show when={download()} fallback={<p>Preparing {props.file.name}…</p>}>
      {(href) => (
        <p><a download={props.file.name} href={href()}>Download {props.file.name}</a></p>
      )}
    </Show>
  );
}

function replaceItem(items: readonly ChatItem[], next: ChatItem): readonly ChatItem[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index < 0) return [...items, next];
  return items.map((item, current) => current === index ? next : item);
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "An unexpected chat error occurred.";
}
