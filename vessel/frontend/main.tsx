import "@picocss/pico/css/pico.min.css";
import "./styles.css";
import { Match, Switch, createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { Session } from "@v/backend/session";
import type { Chat as ChatService } from "./services/chat";
import type { Roster } from "./services/roster";
import { Account } from "./views/Account";
import { Chat } from "./views/Chat";
import { Home } from "./views/Home";
import { Peer } from "./views/Peer";

interface ActiveSession {
  readonly session: Session;
  readonly chat: ChatService;
  readonly roster: Roster;
}

type Location =
  | { readonly view: "account" }
  | ({ readonly view: "home" } & ActiveSession)
  | ({ readonly view: "chat"; readonly peerId: string } & ActiveSession)
  | ({
    readonly view: "peer";
    readonly peerId: string;
    readonly origin: "home" | "chat";
  } & ActiveSession);

function Vessel() {
  const [location, setLocation] = createSignal<Location>({ view: "account" });
  async function activate(session: Session): Promise<void> {
    try {
      const [{ createChat }, { createRoster }] = await Promise.all([
        import("./services/chat"),
        import("./services/roster"),
      ]);
      const chat = createChat(session);
      const roster = await createRoster(session);
      setLocation({
        view: "home",
        session,
        chat,
        roster,
      });
    } catch (error) {
      await session.close().catch(() => {});
      throw error;
    }
  }
  const home = () => {
    const current = location();
    return current.view === "home" ? current : undefined;
  };
  const chat = () => {
    const current = location();
    return current.view === "chat" ? current : undefined;
  };
  const peer = () => {
    const current = location();
    return current.view === "peer" ? current : undefined;
  };

  return (
    <main class="container">
      <header>
        <hgroup>
          <h1>brochain</h1>
          <p>Private peer-to-peer communication.</p>
        </hgroup>
      </header>

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
              onOpenChat={(peerId) =>
                setLocation({
                  view: "chat",
                  session: current().session,
                  chat: current().chat,
                  roster: current().roster,
                  peerId,
                })}
              onOpenPeer={(peerId) =>
                setLocation({
                  view: "peer",
                  origin: "home",
                  session: current().session,
                  chat: current().chat,
                  roster: current().roster,
                  peerId,
                })}
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
              roster={current().roster}
              peerId={current().peerId}
              onOpenPeer={() =>
                setLocation({
                  view: "peer",
                  origin: "chat",
                  session: current().session,
                  chat: current().chat,
                  roster: current().roster,
                  peerId: current().peerId,
                })}
              onBack={() => setLocation({
                view: "home",
                session: current().session,
                chat: current().chat,
                roster: current().roster,
              })}
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
                ...(current().origin === "chat"
                  ? { view: "chat", peerId: current().peerId }
                  : { view: "home" }),
                session: current().session,
                chat: current().chat,
                roster: current().roster,
              })}
            />
          )}
        </Match>
      </Switch>
    </main>
  );
}

const applicationRoot = document.getElementById("root");
if (applicationRoot === null) throw new Error("The application root is missing.");
render(() => <Vessel />, applicationRoot);
