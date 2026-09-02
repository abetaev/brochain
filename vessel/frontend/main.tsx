import "@picocss/pico/css/pico.min.css";
import "./styles.css";
import { Match, Show, Switch, createSignal, onCleanup } from "solid-js";
import { render } from "solid-js/web";
import type { Session } from "@v/backend/session";
import type { Call as CallService, CallState } from "./services/call";
import type { Chat as ChatService } from "./services/chat";
import type { Roster } from "./services/roster";
import { Account } from "./views/Account";
import { Call } from "./views/Call";
import { Chat } from "./views/Chat";
import { Home } from "./views/Home";
import { Peer } from "./views/Peer";

interface ActiveSession {
  readonly session: Session;
  readonly chat: ChatService;
  readonly roster: Roster;
  readonly call: CallService;
}

type Location =
  | { readonly view: "account" }
  | ({ readonly view: "home" } & ActiveSession)
  | ({ readonly view: "chat"; readonly peerId: string } & ActiveSession)
  | ({ readonly view: "call"; readonly peerId: string } & ActiveSession)
  | ({
    readonly view: "peer";
    readonly peerId: string;
    readonly origin: "home" | "chat";
  } & ActiveSession);

function Vessel() {
  const [location, setLocation] = createSignal<Location>({ view: "account" });
  async function activate(session: Session): Promise<void> {
    try {
      const [{ createChat }, { createRoster }, { createCall }] = await Promise.all([
        import("./services/chat"),
        import("./services/roster"),
        import("./services/call"),
      ]);
      const chat = createChat(session);
      const roster = await createRoster(session);
      const call = createCall(session);
      setLocation({ view: "home", session, chat, roster, call });
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
  });
  const at = <View extends Location["view"]>(view: View) => () => {
    const current = location();
    return current.view === view ? current as Extract<Location, { view: View }> : undefined;
  };
  const home = at("home");
  const chat = at("chat");
  const peer = at("peer");
  const call = at("call");

  return (
    <main class="container">
      <header>
        <hgroup>
          <h1>brochain</h1>
          <p>Private peer-to-peer communication.</p>
        </hgroup>
      </header>

      {/* A call reaches a reader wherever they are, and outlives the view it started in. */}
      <Show when={location().view === "call" ? undefined : active()}>
        {(current) => (
          <CallBanner
            call={current().call}
            roster={current().roster}
            onOpen={(peerId) => setLocation({ view: "call", peerId, ...services(current()) })}
          />
        )}
      </Show>

      <Switch>
        <Match when={location().view === "account"}>
          <Account onSignedIn={activate} />
        </Match>
        <Match when={home()}>
          {(current) => (
            <Home
              session={current().session}
              chat={current().chat}
              roster={current().roster}
              onOpenChat={(peerId) => setLocation({ view: "chat", peerId, ...services(current()) })}
              onOpenPeer={(peerId) =>
                setLocation({ view: "peer", origin: "home", peerId, ...services(current()) })}
              onSignedOut={() => {
                setLocation({ view: "account" });
              }}
            />
          )}
        </Match>
        <Match when={chat()}>
          {(current) => (
            <Chat
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
              session={current().session}
              roster={current().roster}
              peerId={current().peerId}
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
    </main>
  );
}

function CallBanner(props: {
  call: CallService;
  roster: Roster;
  onOpen(peerId: string): void;
}) {
  const [state, setState] = createSignal<CallState | undefined>(props.call.current());
  const [names, setNames] = createSignal<ReadonlyMap<string, string>>(new Map());
  const stops = [
    props.call.updates.subscribe((next) => setState(next)),
    props.roster.updates.subscribe((update) => {
      if (update.type !== "set") return;
      setNames((current) => new Map(current).set(update.entry.peerId, update.entry.name));
    }),
  ];
  onCleanup(() => stops.forEach((stop) => stop()));
  const name = (peerId: string) =>
    names().get(peerId) ?? props.roster.get(peerId)?.name ?? peerId;

  return (
    <Show when={state()}>
      {(current) => (
        <aside role="status">
          <Switch>
            <Match when={current().status === "ended"}>
              <p>{current().error ?? "The call ended."}</p>
              <button type="button" onClick={() => props.call.dismiss()}>Dismiss</button>
            </Match>
            <Match when={current().status === "pending" && current().direction === "incoming"}>
              <p>{name(current().peerId)} is calling.</p>
              <button
                type="button"
                onClick={() => {
                  const peerId = current().peerId;
                  void props.call.accept();
                  props.onOpen(peerId);
                }}
              >
                Accept call
              </button>{" "}
              <button type="button" class="secondary" onClick={() => props.call.decline()}>
                Decline call
              </button>
            </Match>
            <Match when={current().status === "pending"}>
              <p>Calling {name(current().peerId)}…</p>
              <button type="button" onClick={() => props.call.end()}>Hang up</button>
            </Match>
            <Match when={true}>
              <p>In a call with {name(current().peerId)}.</p>
              <button type="button" onClick={() => props.onOpen(current().peerId)}>
                Open call
              </button>{" "}
              <button type="button" class="secondary" onClick={() => props.call.end()}>
                Hang up
              </button>
            </Match>
          </Switch>
        </aside>
      )}
    </Show>
  );
}

const applicationRoot = document.getElementById("root");
if (applicationRoot === null) throw new Error("The application root is missing.");
render(() => <Vessel />, applicationRoot);
