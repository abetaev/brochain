import { For, Show, createSignal, onCleanup } from "solid-js";
import type { Session } from "@v/backend/session";
import { defaultBeaconAddress } from "@v/backend/network";
import type { Chat } from "@v/frontend/services/chat";
import type { Roster, RosterEntry, RosterUpdate } from "@v/frontend/services/roster";

export function Home(props: {
  session: Session;
  chat: Chat;
  roster: Roster;
  onOpenChat(peerId: string): void;
  onSignedOut(): void;
}) {
  const [actionError, setActionError] = createSignal<string>();
  const [beaconError, setBeaconError] = createSignal<string>();
  const [actionBusy, setActionBusy] = createSignal(false);
  const [peers, setPeers] = createSignal(props.roster.list());
  const receivedByPeer = new Map<string, Set<string>>();
  const [unread, setUnread] = createSignal<ReadonlyMap<string, boolean>>(new Map());

  function receivedIds(peerId: string): Set<string> {
    let ids = receivedByPeer.get(peerId);
    if (ids === undefined) {
      ids = new Set(props.chat.history(peerId)
        .filter((item) => item.direction === "received")
        .map((item) => item.id));
      receivedByPeer.set(peerId, ids);
    }
    return ids;
  }

  function updateUnread(peerId: string, read = props.chat.readCount(peerId)): void {
    const next = receivedIds(peerId).size > read;
    setUnread((current) => current.get(peerId) === next
      ? current
      : new Map(current).set(peerId, next));
  }

  function hasUnread(peerId: string): boolean {
    return unread().get(peerId) ??
      (receivedIds(peerId).size > props.chat.readCount(peerId));
  }

  const stops = [
    props.roster.updates.subscribe((update) => {
      setPeers((current) => applyRosterUpdate(current, update));
    }),
    props.chat.updates.subscribe((item) => {
      if (item.direction !== "received") return;
      receivedIds(item.peerId).add(item.id);
      updateUnread(item.peerId);
    }),
    props.chat.reads.subscribe(({ peerId, count }) => {
      updateUnread(peerId, count);
    }),
  ];
  const stopObserving = () => stops.forEach((stop) => stop());
  const unavailable = actionBusy;
  const network = props.session.network();

  async function connectBeacon(): Promise<void> {
    try {
      await network.connect(defaultBeaconAddress());
      setBeaconError(undefined);
    } catch (reason) {
      const message = errorMessage(reason);
      setBeaconError(message);
      throw reason;
    }
  }

  async function performAction(operation: () => Promise<void>): Promise<void> {
    setActionError(undefined);
    setActionBusy(true);
    try {
      await operation();
    } catch (reason) {
      setActionError(errorMessage(reason));
    } finally {
      setActionBusy(false);
    }
  }

  async function connectAndOpen(addresses: readonly string[]): Promise<void> {
    const [address, ...alternates] = addresses;
    if (address === undefined) throw new Error("This peer has no known address.");
    const connected = await network.connect(address, ...alternates);
    await connected.refreshServices();
    if (!props.chat.capabilities(connected).text) {
      throw new Error("This peer does not provide messaging.");
    }
    props.onOpenChat(connected.id);
  }

  async function connectDirect(
    event: SubmitEvent & { currentTarget: HTMLFormElement },
  ): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const address = String(new FormData(form).get("direct-address") ?? "").trim();
    await performAction(async () => {
      await connectAndOpen([address]);
      form.reset();
    });
  }

  async function signOut(): Promise<void> {
    stopObserving();
    await props.session.close().catch(() => {});
    props.onSignedOut();
  }

  onCleanup(stopObserving);
  void connectBeacon().catch(() => {});

  return (
    <section aria-labelledby="home-heading">
      <header>
        <h2 id="home-heading">Home</h2>
        <p>Signed in as {props.session.username}.</p>
      </header>
      <Show when={beaconError()}>
        {(message) => <p role="alert">Peer networking is unavailable: {message()}</p>}
      </Show>
      <Show when={actionError()}>{(message) => <p role="alert">{message()}</p>}</Show>

      <button
        class="secondary"
        type="button"
        disabled={unavailable()}
        onClick={() => void performAction(async () => {
          await connectBeacon();
          await props.roster.refresh();
        })}
      >
        Refresh peers
      </button>

      <section aria-labelledby="peers-heading">
        <h3 id="peers-heading">Peers</h3>
        <Show when={peers().length > 0} fallback={<p>No peers are currently known.</p>}>
          <ul>
            <For each={peers()}>
              {(peer) => (
                <PeerRow
                  listed={peer}
                  chat={props.chat}
                  unread={hasUnread(peer.peerId)}
                  busy={unavailable()}
                  onConnect={(selected) => void performAction(
                    () => connectAndOpen(selected.addresses),
                  )}
                  onOpenChat={props.onOpenChat}
                />
              )}
            </For>
          </ul>
        </Show>
      </section>

      <details>
        <summary>Connect directly</summary>
        <form onSubmit={connectDirect}>
          <label for="direct-address">
            Peer multiaddress
            <input
              id="direct-address"
              name="direct-address"
              required
              placeholder="/dns4/example.com/tcp/9090/ws/p2p/..."
            />
          </label>
          <button type="submit" disabled={unavailable()}>Connect directly</button>
        </form>
      </details>

      <button
        type="button"
        class="secondary"
        disabled={unavailable()}
        onClick={() => void performAction(signOut)}
      >
        Sign out
      </button>
    </section>
  );
}

function PeerRow(props: {
  listed: RosterEntry;
  chat: Chat;
  unread: boolean;
  busy: boolean;
  onConnect(peer: RosterEntry): void;
  onOpenChat(peerId: string): void;
}) {
  const capabilities = () => props.listed.peer === undefined
    ? undefined
    : props.chat.capabilities(props.listed.peer);

  return (
    <li>
      <span
        classList={{ "connection-state": true, connected: props.listed.online }}
        aria-label={props.listed.online ? "Connected" : "Not connected"}
      />
      <strong>{props.listed.name}</strong>{" "}
      <Show when={props.unread}>
        <span class="unread-state" aria-label="Unread messages" title="Unread messages">
          ●
        </span>{" "}
      </Show>
      <Show
        when={props.listed.online}
        fallback={
          <Show
            when={props.listed.addresses.length > 0}
            fallback={<small>Not currently available</small>}
          >
            <button
              type="button"
              disabled={props.busy}
              onClick={() => props.onConnect(props.listed)}
            >
              Connect
            </button>
          </Show>
        }
      >
        <Show when={capabilities()?.text} fallback={<small>Connected</small>}>
          <button
            type="button"
            onClick={() => props.onOpenChat(props.listed.peerId)}
          >
            Chat
          </button>
        </Show>
      </Show>
    </li>
  );
}

function applyRosterUpdate(
  entries: readonly RosterEntry[],
  update: RosterUpdate,
): readonly RosterEntry[] {
  if (update.type === "remove") {
    return entries.filter(({ peerId }) => peerId !== update.peerId);
  }
  const index = entries.findIndex(({ peerId }) => peerId === update.entry.peerId);
  if (index < 0) return [...entries, update.entry];
  return entries.map((entry, position) => position === index ? update.entry : entry);
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "An unexpected network error occurred.";
}
