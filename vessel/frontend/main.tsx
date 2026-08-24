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

interface ActiveSession {
  readonly session: Session;
  readonly chat: ChatService;
  readonly roster: Roster;
}

type Location =
  | { readonly view: "account" }
  | ({ readonly view: "home" } & ActiveSession)
  | ({ readonly view: "chat"; readonly peerId: string } & ActiveSession);

function Vessel() {
  const [location, setLocation] = createSignal<Location>({ view: "account" });
  async function activate(session: Session): Promise<void> {
    try {
      const [{ createChat }, { createRoster }] = await Promise.all([
        import("./services/chat"),
        import("./services/roster"),
      ]);
      const chat = await createChat(session);
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
              onSignedOut={() => {
                setLocation({ view: "account" });
              }}
            />
          )}
        </Match>
        <Match when={chat()}>
          {(current) => (
            <Chat
              session={current().session}
              chat={current().chat}
              roster={current().roster}
              peerId={current().peerId}
              onBack={() => setLocation({
                view: "home",
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
