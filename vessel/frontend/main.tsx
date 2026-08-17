import "@picocss/pico/css/pico.min.css";
import "./styles.css";
import { Match, Switch, createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { Session } from "@v/backend/session";
import { Account } from "./Account";
import { Chat } from "./Chat";
import { Home } from "./Home";

type Location =
  | { readonly view: "account" }
  | { readonly view: "home"; readonly session: Session }
  | { readonly view: "chat"; readonly session: Session; readonly peerId: string };

function Vessel() {
  const [location, setLocation] = createSignal<Location>({ view: "account" });
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
          <Account onSignedIn={(session) => setLocation({ view: "home", session })} />
        </Match>
        <Match when={home()}>
          {(current) => (
            <Home
              session={current().session}
              onOpenChat={(peerId) =>
                setLocation({ view: "chat", session: current().session, peerId })}
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
              peerId={current().peerId}
              onBack={() => setLocation({ view: "home", session: current().session })}
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
