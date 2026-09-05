import "./styles.css";
import { Match, Switch, createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { Session } from "@v/backend/session";
import type { Call as CallService } from "./services/call";
import type { Chat as ChatService } from "./services/chat";
import type { Notification, Notifications } from "./services/notifications";
import type { Roster } from "./services/roster";
import { Account } from "./views/Account";
import { Call } from "./views/Call";
import { Chat } from "./views/Chat";
import { Home } from "./views/Home";
import { Peer } from "./views/Peer";
import { Settings } from "./views/Settings";

interface ActiveSession {
  readonly session: Session;
  readonly chat: ChatService;
  readonly roster: Roster;
  readonly call: CallService;
  readonly notifications: Notifications;
}

type Location =
  | { readonly view: "account" }
  | ({ readonly view: "home" } & ActiveSession)
  | ({ readonly view: "settings" } & ActiveSession)
  | ({ readonly view: "chat"; readonly peerId: string } & ActiveSession)
  | ({ readonly view: "call"; readonly peerId: string } & ActiveSession)
  | ({
    readonly view: "peer";
    readonly peerId: string;
    readonly origin: "home" | "chat";
  } & ActiveSession);

function Vessel() {
  const [location, setLocation] = createSignal<Location>({ view: "account" });
  const [waiting, setWaiting] = createSignal<readonly Notification[]>([]);
  async function activate(session: Session): Promise<void> {
    try {
      const [
        { createChat },
        { createRoster },
        { createCall },
        { createNotifications },
      ] = await Promise.all([
        import("./services/chat"),
        import("./services/roster"),
        import("./services/call"),
        import("./services/notifications"),
      ]);
      // Chat records what happens with a peer, a call included, so it subscribes
      // before anything else can react to one.
      const call = createCall(session);
      const chat = createChat(session, call);
      const roster = await createRoster(session);
      const notifications = createNotifications({ chat, call, roster });
      notifications.updates.subscribe(setWaiting);
      setWaiting(notifications.list());
      // The call view is for a call that is running: it opens when one is answered
      // and closes the moment it is over.
      call.updates.subscribe((state) => {
        const current = location();
        if (current.view === "account") return;
        const running = state !== undefined &&
          (state.status === "connecting" || state.status === "active");
        if (running) {
          if (current.view !== "call" || current.peerId !== state.peerId) {
            setLocation({ view: "call", peerId: state.peerId, ...services(current) });
          }
        } else if (current.view === "call") {
          setLocation({ view: "chat", peerId: current.peerId, ...services(current) });
        }
      });
      setLocation({ view: "home", session, chat, roster, call, notifications });
    } catch (error) {
      await session.close().catch(() => {});
      throw error;
    }
  }
  const active = (): ActiveSession | undefined => {
    const current = location();
    return current.view === "account" ? undefined : current;
  };
  const services = (current: ActiveSession): ActiveSession => ({
    session: current.session,
    chat: current.chat,
    roster: current.roster,
    call: current.call,
    notifications: current.notifications,
  });
  const at = <View extends Location["view"]>(view: View) => () => {
    const current = location();
    return current.view === view ? current as Extract<Location, { view: View }> : undefined;
  };
  // A call outlives the view it started in and a message arrives wherever the
  // reader is, so both reach them through the one StatusBar every view carries.
  function open(peerId: string, mode: Notification["call"]): void {
    const current = active();
    if (current === undefined) return;
    // A call still ringing is answered in the conversation; only a running one
    // has a call view to reach.
    setLocation(mode === "ongoing"
      ? { view: "call", peerId, ...services(current) }
      : { view: "chat", peerId, ...services(current) });
  }
  const notifications = (): readonly Notification[] => {
    const current = location();
    const watching = current.view === "call" ? current.peerId : undefined;
    return waiting().flatMap((held): Notification[] => {
      // The call being watched is not something waiting elsewhere.
      const mode = held.peerId === watching ? undefined : held.call;
      if (!held.unread && mode === undefined) return [];
      return [{ ...held, call: mode, onClick: () => open(held.peerId, mode) }];
    });
  };

  const home = at("home");
  const settings = at("settings");
  const chat = at("chat");
  const peer = at("peer");
  const call = at("call");

  return (
    <div class="app-shell">
      <Switch>
        <Match when={location().view === "account"}>
          <Account onSignedIn={activate} />
        </Match>
        <Match when={home()}>
          {(current) => (
            <Home
              notifications={notifications()}
              session={current().session}
              chat={current().chat}
              roster={current().roster}
              onOpenChat={(peerId) => setLocation({ view: "chat", peerId, ...services(current()) })}
              onOpenPeer={(peerId) =>
                setLocation({ view: "peer", origin: "home", peerId, ...services(current()) })}
              onOpenSettings={() => setLocation({ view: "settings", ...services(current()) })}
              onSignedOut={() => {
                setWaiting([]);
                setLocation({ view: "account" });
              }}
            />
          )}
        </Match>
        <Match when={settings()}>
          {(current) => (
            <Settings
              notifications={notifications()}
              session={current().session}
              onBack={() => setLocation({ view: "home", ...services(current()) })}
            />
          )}
        </Match>
        <Match when={chat()}>
          {(current) => (
            <Chat
              notifications={notifications()}
              chat={current().chat}
              call={current().call}
              roster={current().roster}
              peerId={current().peerId}
              onOpenPeer={() =>
                setLocation({
                  view: "peer",
                  origin: "chat",
                  peerId: current().peerId,
                  ...services(current()),
                })}
              onOpenCall={() =>
                setLocation({ view: "call", peerId: current().peerId, ...services(current()) })}
              onBack={() => setLocation({ view: "home", ...services(current()) })}
            />
          )}
        </Match>
        <Match when={call()}>
          {(current) => (
            <Call
              notifications={notifications()}
              session={current().session}
              call={current().call}
              roster={current().roster}
              peerId={current().peerId}
              onBack={() =>
                setLocation({ view: "chat", peerId: current().peerId, ...services(current()) })}
            />
          )}
        </Match>
        <Match when={peer()}>
          {(current) => (
            <Peer
              notifications={notifications()}
              session={current().session}
              roster={current().roster}
              call={current().call}
              peerId={current().peerId}
              onOpenChat={(peerId) =>
                setLocation({ view: "chat", peerId, ...services(current()) })}
              onBack={() => setLocation({
                ...services(current()),
                ...(current().origin === "chat"
                  ? { view: "chat", peerId: current().peerId }
                  : { view: "home" }),
              })}
            />
          )}
        </Match>
      </Switch>
    </div>
  );
}

const applicationRoot = document.getElementById("root");
if (applicationRoot === null) throw new Error("The application root is missing.");
render(() => <Vessel />, applicationRoot);
