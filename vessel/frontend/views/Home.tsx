import { For, Show, createSignal, onCleanup } from "solid-js";
import type { Session } from "@v/backend/session";
import type { Action } from "@v/frontend/components/ActionBar";
import { Avatar } from "@v/frontend/components/Avatar";
import { Badge } from "@v/frontend/components/Badge";
import { List } from "@v/frontend/components/List";
import { ListItem } from "@v/frontend/components/ListItem";
import { TextField } from "@v/frontend/components/TextField";
import { Handheld } from "@v/frontend/layouts/Handheld";
import type { Chat } from "@v/frontend/services/chat";
import type { Roster, RosterEntry, RosterUpdate } from "@v/frontend/services/roster";

export function Home(props: {
  session: Session;
  chat: Chat;
  roster: Roster;
  onOpenChat(peerId: string): void;
  onOpenPeer(peerId: string): void;
  onSignedOut(): void;
}) {
  const [actionError, setActionError] = createSignal<string>();
  const [beaconError, setBeaconError] = createSignal<string>();
  const [actionBusy, setActionBusy] = createSignal(false);
  const [peers, setPeers] = createSignal(props.roster.list());
  const receivedByPeer = new Map<string, Set<string>>();
  const [unread, setUnread] = createSignal<ReadonlyMap<string, boolean>>(new Map());
  let detailsElement: HTMLDetailsElement | undefined;

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

  // A direct connection only completes the connection procedure; the peer then
  // appears in the list like any other, whatever services it turns out to offer.
  async function connectDirect(
    event: SubmitEvent & { currentTarget: HTMLFormElement },
  ): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const entered = String(new FormData(form).get("direct-address") ?? "");
    await performAction(async () => {
      await network.connect(peerAddress(entered));
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

  const actions = (): Action[] => [
    {
      side: "start",
      icon: "🖐️",
      label: "Sign out",
      disabled: unavailable(),
      onClick: () => void performAction(signOut),
    },
    {
      side: "end",
      icon: "🔗",
      label: "Connect",
      onClick: () => {
        if (detailsElement !== undefined) detailsElement.open = true;
        detailsElement?.scrollIntoView({ behavior: "smooth", block: "center" });
      },
    },
  ];

  return (
    // The local avatar opens local settings once that view exists.
    <Handheld
      avatar={{ seed: props.session.username, name: props.session.username }}
      title="Brochain"
      heading="Home"
      actions={actions()}
    >
      <>
        <Show when={beaconError()}>
          {(message) => <p role="alert">Peer networking is unavailable: {message()}</p>}
        </Show>
        <Show when={actionError()}>{(message) => <p role="alert">{message()}</p>}</Show>

        <Show when={peers().length > 0} fallback={<p>No peers are currently known.</p>}>
          <List>
            <For each={peers()}>
              {(peer) => (
                <PeerRow
                  listed={peer}
                  unread={hasUnread(peer.peerId)}
                  busy={unavailable()}
                  onConnect={(selected) => void performAction(
                    () => connectAndOpen(selected.addresses),
                  )}
                  onOpenChat={props.onOpenChat}
                  onOpenPeer={props.onOpenPeer}
                />
              )}
            </For>
          </List>
        </Show>

        <button
          type="button"
          class="text-button"
          disabled={unavailable()}
          onClick={() => void performAction(async () => {
            await connectBeacon();
            await props.roster.refresh();
          })}
        >
          Refresh peers
        </button>

        <details class="panel" ref={detailsElement}>
          <summary>Connect directly</summary>
          <form onSubmit={connectDirect}>
            <TextField
              id="direct-address"
              name="direct-address"
              label="Peer address or URL"
              required
            />
            <button type="submit" class="text-button primary" disabled={unavailable()}>
              Connect directly
            </button>
          </form>
        </details>
      </>
    </Handheld>
  );
}

function PeerRow(props: {
  listed: RosterEntry;
  unread: boolean;
  busy: boolean;
  onConnect(peer: RosterEntry): void;
  onOpenChat(peerId: string): void;
  onOpenPeer(peerId: string): void;
}) {
  return (
    <ListItem
      avatar={
        <Avatar
          seed={props.listed.peerId}
          name={props.listed.name}
          badges={<Show when={props.unread}><Badge variant="unread" /></Show>}
          onClick={() => props.onOpenPeer(props.listed.peerId)}
          label={`${props.listed.name} settings`}
        />
      }
      label={props.listed.name}
      onClick={() => props.onOpenChat(props.listed.peerId)}
      actions={
        <>
          <span
            classList={{ "connection-state": true, connected: props.listed.online }}
            aria-label={props.listed.online ? "Connected" : "Not connected"}
          />
          <Show when={!props.listed.online}>
            <Show
              when={props.listed.addresses.length > 0}
              fallback={<small>Not currently available</small>}
            >
              <button
                type="button"
                class="text-button"
                disabled={props.busy}
                onClick={() => props.onConnect(props.listed)}
              >
                Connect
              </button>
            </Show>
          </Show>
        </>
      }
    />
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

// People are given peer locations as URLs far more often than as multiaddresses,
// so both are accepted and a URL is translated to the address libp2p dials.
function peerAddress(entered: string): string {
  const value = entered.trim();
  if (value.startsWith("/")) return value;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a peer multiaddress or an http or https URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Enter a peer multiaddress or an http or https URL.");
  }

  const secure = url.protocol === "https:";
  const port = url.port === "" ? (secure ? 443 : 80) : Number(url.port);
  return `${hostAddress(url.hostname)}/tcp/${port}${secure ? "/tls" : ""}/ws`;
}

// Vessel and its Beacon are served from one origin, so the page already knows
// where its Beacon is.
function defaultBeaconAddress(): string {
  return peerAddress(window.location.origin);
}

function hostAddress(hostname: string): string {
  if (hostname.startsWith("[")) return `/ip6/${hostname.slice(1, -1)}`;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ? `/ip4/${hostname}` : `/dns4/${hostname}`;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "An unexpected network error occurred.";
}
