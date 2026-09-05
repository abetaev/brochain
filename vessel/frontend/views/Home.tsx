import { For, Show, createSignal, onCleanup } from "solid-js";
import {
  displayName,
  observeDisplayName,
} from "@v/backend/options/peer-names";
import type { Session } from "@v/backend/session";
import type { Action } from "@v/frontend/components/ActionBar";
import { Avatar } from "@v/frontend/components/Avatar";
import { Badge } from "@v/frontend/components/Badge";
import { Dialog } from "@v/frontend/components/Dialog";
import { List } from "@v/frontend/components/List";
import { ListItem } from "@v/frontend/components/ListItem";
import { TextField } from "@v/frontend/components/TextField";
import type { Notification } from "@v/frontend/services/notifications";
import { Handheld } from "@v/frontend/layouts/Handheld";
import type { Roster, RosterEntry, RosterUpdate } from "@v/frontend/services/roster";

// Development installs under a name of its own, and the view says the same one,
// because two installed applications are told apart by what they are called.
const applicationName = import.meta.env.DEV ? "brochain [dev]" : "brochain";

export function Home(props: {
  session: Session;
  roster: Roster;
  notifications: readonly Notification[];
  onOpenChat(peerId: string): void;
  onOpenPeer(peerId: string): void;
  onOpenSettings(): void;
  onSignedOut(): void;
}) {
  const [actionError, setActionError] = createSignal<string>();
  const [beaconError, setBeaconError] = createSignal<string>();
  const [connectError, setConnectError] = createSignal<string>();
  const [connectOpen, setConnectOpen] = createSignal(false);
  const [actionBusy, setActionBusy] = createSignal(false);
  const [peers, setPeers] = createSignal(props.roster.list());
  const localId = props.session.network().id;
  const [chosenName, setChosenName] = createSignal(
    displayName(props.session.options(), localId),
  );
  // This peer is named under its own peer ID like any other; the account username
  // names it until a name of its own is chosen.
  const localName = () => chosenName() ?? props.session.username;

  // What waits for a reader is gathered once, for the status bar and for the rows
  // alike, so Home counts nothing of its own.
  const waiting = (peerId: string): Notification | undefined =>
    props.notifications.find((notification) => notification.peerId === peerId);

  const stops = [
    observeDisplayName(props.session.options(), localId, setChosenName),
    props.roster.updates.subscribe((update) => {
      setPeers((current) => applyRosterUpdate(current, update));
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

  async function performAction(
    operation: () => Promise<void>,
    report = setActionError,
  ): Promise<void> {
    report(undefined);
    setActionBusy(true);
    try {
      await operation();
    } catch (reason) {
      report(errorMessage(reason));
    } finally {
      setActionBusy(false);
    }
  }

  // A direct connection only completes the connection procedure; the peer then
  // appears in the list like any other, whatever services it turns out to offer.
  // The dialog stays open while it fails, because that is where the address is.
  async function connectDirect(form: HTMLFormElement): Promise<void> {
    const entered = String(new FormData(form).get("direct-address") ?? "");
    await performAction(async () => {
      await network.connect(peerAddress(entered));
      form.reset();
      setConnectOpen(false);
    }, setConnectError);
  }

  async function signOut(): Promise<void> {
    stopObserving();
    await props.session.close().catch(() => {});
    props.onSignedOut();
  }

  onCleanup(stopObserving);
  void connectBeacon().catch(() => {});

  // Both ways of reaching people sit together at the end of the bar: looking again
  // for those the Beacon knows, and going straight to an address.
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
      group: "peers",
      icon: "🤌",
      label: "Refresh peers",
      disabled: unavailable(),
      onClick: () => void performAction(async () => {
        await connectBeacon();
        await props.roster.refresh();
      }),
    },
    {
      side: "end",
      group: "peers",
      icon: "🔗",
      label: "Connect directly",
      onClick: () => {
        setConnectError(undefined);
        setConnectOpen(true);
      },
    },
  ];

  return (
    // This peer's own avatar is the way to this peer's own settings.
    <Handheld
      avatar={{
        seed: localId,
        name: localName(),
        onClick: props.onOpenSettings,
        label: "Settings",
      }}
      title={applicationName}
      heading="Home"
      notifications={props.notifications}
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
                  waiting={waiting(peer.peerId)}
                  onOpenChat={props.onOpenChat}
                  onOpenPeer={props.onOpenPeer}
                />
              )}
            </For>
          </List>
        </Show>

        <Dialog
          open={connectOpen()}
          title="Connect"
          confirmLabel="Connect"
          disabled={unavailable()}
          onCancel={() => setConnectOpen(false)}
          onConfirm={(form) => void connectDirect(form)}
        >
          <TextField
            id="direct-address"
            name="direct-address"
            label="Peer address"
            required
          />
          <Show when={connectError()}>{(message) => <p role="alert">{message()}</p>}</Show>
        </Dialog>
      </>
    </Handheld>
  );
}

// A row is a peer, not a status report: the name is the only text, and everything
// else about that peer hangs off its avatar.
function PeerRow(props: {
  listed: RosterEntry;
  waiting?: Notification;
  onOpenChat(peerId: string): void;
  onOpenPeer(peerId: string): void;
}) {
  // A peer we hold no address for cannot be reached at all; one we do is simply
  // not connected yet.
  const connection = () => {
    if (props.listed.online) return "connected" as const;
    return props.listed.addresses.length > 0 ? "disconnected" as const : "unavailable" as const;
  };

  return (
    <ListItem
      avatar={
        <Avatar
          seed={props.listed.peerId}
          name={props.listed.name}
          badges={
            <>
              <Show when={props.waiting?.unread}><Badge variant="unread" /></Show>
              <Show
                when={props.waiting?.call}
                fallback={<Badge variant="connection" state={connection()} />}
              >
                {(mode) => <Badge variant="call" mode={mode()} />}
              </Show>
            </>
          }
          onClick={() => props.onOpenPeer(props.listed.peerId)}
          label={`${props.listed.name} settings`}
        />
      }
      label={props.listed.name}
      onClick={() => props.onOpenChat(props.listed.peerId)}
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
