import { For, Show, createResource, createSignal, onCleanup } from "solid-js";
import type { Peer } from "@c/backend/network";
import type { Action } from "@v/frontend/components/ActionBar";
import { selfAccentColor, selfBubbleColor } from "@v/frontend/components/colors";
import { Feed, FeedEntry } from "@v/frontend/components/Feed";
import { Handheld } from "@v/frontend/layouts/Handheld";
import "./Chat.css";
import type { Call } from "@v/frontend/services/call";
import type { Chat as ChatService, ChatFile, ChatItem } from "@v/frontend/services/chat";
import type { Roster } from "@v/frontend/services/roster";

export function Chat(props: {
  chat: ChatService;
  call: Call;
  roster: Roster;
  peerId: string;
  onOpenPeer(): void;
  onOpenCall(): void;
  onBack(): void;
}) {
  const [items, setItems] = createSignal(props.chat.history(props.peerId));
  const [actionError, setActionError] = createSignal<string>();
  const [entry, setEntry] = createSignal(props.roster.get(props.peerId));
  let fileInput: HTMLInputElement | undefined;
  const connectedPeer = (): Peer | undefined => {
    const peer = entry()?.peer;
    return peer?.isConnected() === true ? peer : undefined;
  };
  const capabilities = () => {
    const peer = connectedPeer();
    return peer === undefined ? undefined : props.chat.capabilities(peer);
  };
  const callable = () => {
    const peer = connectedPeer();
    return peer !== undefined && props.call.available(peer);
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

  function startCall(): void {
    attemptSend(() => {
      const current = connectedPeer();
      if (current === undefined || !callable()) {
        throw new Error("Calls are not available.");
      }
      // Navigating disposes this view, and with it every prop it could still read,
      // so the call is placed before the reader is taken to it.
      void props.call.start(current);
      props.onOpenCall();
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

  const actions = (): Action[] => [
    { side: "start", icon: "👈", label: "Back to Home", onClick: props.onBack },
    { side: "end", icon: "🤙", label: "Call", disabled: !callable(), onClick: startCall },
  ];

  const compose = () => (
    <form id="send-message-form" onSubmit={sendText} class="compose-bar">
      <div class="pill" style={{ background: selfBubbleColor }}>
        <label for="message" class="sr-only">Message</label>
        {/* A textarea so a message can run to several lines, and so the browser
            keeps no history of what was typed here to offer back later. */}
        <textarea
          id="message"
          name="message"
          rows={1}
          placeholder="Type a message…"
          required
          autocomplete="off"
          autocapitalize="sentences"
          spellcheck={true}
          disabled={connectedPeer() === undefined || capabilities()?.text !== true}
        />
        <button
          type="button"
          class="attach-button"
          aria-label="Attach a file"
          disabled={connectedPeer() === undefined || capabilities()?.files !== true}
          onClick={() => fileInput?.click()}
        >
          📎
        </button>
      </div>
      <button
        type="submit"
        class="send-button"
        style={{ background: selfAccentColor }}
        aria-label="Send message"
        disabled={connectedPeer() === undefined || capabilities()?.text !== true}
      >
        🚀
      </button>
    </form>
  );

  return (
    <Handheld
      avatar={{
        seed: props.peerId,
        name: name(),
        onClick: props.onOpenPeer,
        label: `${name()} settings`,
      }}
      title={name()}
      heading={`Chat with ${name()}`}
      actions={actions()}
      footer={compose()}
    >
      <>
        <Show when={actionError() ?? availabilityError()}>
          {(message) => <p role="alert">{message()}</p>}
        </Show>
        <Feed>
          <For each={items()}>
            {(item) => (
              <FeedEntry
                direction={item.direction}
                avatarSeed={item.direction === "sent" ? "you" : props.peerId}
                avatarName={item.direction === "sent" ? "You" : name()}
              >
                {item.kind === "text" ? (
                  <p>{item.text}</p>
                ) : (
                  <FileItem item={item} />
                )}
                <Show when={item.status === "failed"}>
                  <p role="alert">{item.error ?? "Transfer failed."}</p>
                </Show>
              </FeedEntry>
            )}
          </For>
        </Feed>
        <label class="sr-only">
          Send a file
          <input
            ref={fileInput}
            id="file"
            type="file"
            disabled={connectedPeer() === undefined || capabilities()?.files !== true}
            onChange={sendFile}
          />
        </label>
      </>
    </Handheld>
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
