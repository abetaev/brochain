import { For, Show } from "solid-js";
import { Avatar } from "@v/frontend/components/Avatar";
import { Badge } from "@v/frontend/components/Badge";
import "./StatusBar.css";

// A peer wanting attention: their avatar carries a badge per waiting thing, and
// tapping it opens that peer.
export interface Notification {
  readonly peerId: string;
  readonly name: string;
  readonly unread?: boolean;
  readonly call?: "incoming" | "ongoing";
  readonly onClick?: () => void;
}

export function StatusBar(props: {
  icon?: string;
  title: string;
  notifications?: readonly Notification[];
}) {
  return (
    <header class="statusbar">
      <Show when={props.icon}>
        {(icon) => <span class="statusbar-icon" aria-hidden="true">{icon()}</span>}
      </Show>
      <h2 class="statusbar-title">{props.title}</h2>
      <Show when={(props.notifications?.length ?? 0) > 0}>
        <ul class="statusbar-notifications">
          <For each={props.notifications}>
            {(notification) => (
              <li>
                <Avatar
                  seed={notification.peerId}
                  name={notification.name}
                  size="sm"
                  label={notification.name}
                  onClick={notification.onClick}
                  badges={
                    <>
                      <Show when={notification.unread}><Badge variant="unread" /></Show>
                      <Show when={notification.call}>
                        {(mode) => <Badge variant="call" mode={mode()} />}
                      </Show>
                    </>
                  }
                />
              </li>
            )}
          </For>
        </ul>
      </Show>
    </header>
  );
}
