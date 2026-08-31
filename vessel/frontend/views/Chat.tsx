import { For, Show, createResource, createSignal, onCleanup } from "solid-js";
import type { Peer } from "@c/backend/network";
import type { Chat as ChatService, ChatFile, ChatItem } from "@v/frontend/services/chat";
import type { Roster } from "@v/frontend/services/roster";

export function Chat(props: {
  chat: ChatService;
  roster: Roster;
  peerId: string;
  onOpenPeer(): void;
  onBack(): void;
}) {
  const [items, setItems] = createSignal(props.chat.history(props.peerId));
  const [actionError, setActionError] = createSignal<string>();
  const [entry, setEntry] = createSignal(props.roster.get(props.peerId));
  const connectedPeer = (): Peer | undefined => {
    const peer = entry()?.peer;
    return peer?.isConnected() === true ? peer : undefined;
  };
  const capabilities = () => {
    const peer = connectedPeer();
    return peer === undefined ? undefined : props.chat.capabilities(peer);
  };
  const name = () => entry()?.name ?? props.peerId;

  props.chat.markRead(props.peerId);

  const stopEvents = props.chat.updates.subscribe((item) => {
    if (item.peerId !== props.peerId) return;
    const received = item.direction === "received" &&
      items().every((current) => current.id !== item.id);
    setItems((current) => replaceItem(current, item));
    if (received) props.chat.markRead(item.peerId);
  });
  const stopRoster = props.roster.updates.subscribe((update) => {
    if (update.type === "set") {
      if (update.entry.peerId === props.peerId) setEntry(update.entry);
    } else if (update.peerId === props.peerId) {
      setEntry(undefined);
    }
  });

  function attemptSend(operation: () => void): void {
    setActionError(undefined);
    try {
      operation();
    } catch (reason) {
      setActionError(errorMessage(reason));
    }
  }

  function sendText(
    event: SubmitEvent & { currentTarget: HTMLFormElement },
  ): void {
    event.preventDefault();
    const form = event.currentTarget;
    attemptSend(() => {
      const current = connectedPeer();
      if (current === undefined || capabilities()?.text !== true) {
        throw new Error("Messaging is not available.");
      }
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
      const current = connectedPeer();
      if (current === undefined || capabilities()?.files !== true) {
        throw new Error("Data transfer is not available.");
      }
      props.chat.sendFile(current, file);
      event.currentTarget.value = "";
    });
  }

  function availabilityError(): string | undefined {
    const current = entry();
    if (current === undefined) return "This peer is no longer available.";
    if (current.peer === undefined) return "This peer is not currently available.";
    if (!current.peer.isConnected()) return "This peer is not connected.";
    if (capabilities()?.text === false) {
      return "This peer does not provide messaging.";
    }
    return undefined;
  }

  onCleanup(() => {
    stopEvents();
    stopRoster();
  });

  return (
    <section aria-labelledby="chat-heading">
      <header>
        <button class="secondary" type="button" onClick={props.onBack}>Back to Home</button>{" "}
        <button class="secondary" type="button" onClick={props.onOpenPeer}>Settings</button>
        <h2 id="chat-heading">Chat with {name()}</h2>
      </header>
      <Show when={actionError() ?? availabilityError()}>
        {(message) => <p role="alert">{message()}</p>}
      </Show>
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
            disabled={connectedPeer() === undefined || capabilities()?.text !== true}
          />
        </label>
        <button
          type="submit"
          disabled={connectedPeer() === undefined || capabilities()?.text !== true}
        >
          Send message
        </button>
      </form>
      <label for="file">
        Send a file
        <input
          id="file"
          type="file"
          disabled={connectedPeer() === undefined || capabilities()?.files !== true}
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
