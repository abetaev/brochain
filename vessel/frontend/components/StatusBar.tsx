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

// Whose view this is — the local peer on Home, the remote peer on Chat and Peer.
export interface Designation {
  readonly seed: string;
  readonly name: string;
  readonly onClick?: () => void;
  readonly label?: string;
}

export function StatusBar(props: {
  icon?: string;
  avatar?: Designation;
  title: string;
  /** Overrides the accessible heading when it differs from the visible title. */
  heading?: string;
  notifications?: readonly Notification[];
}) {
  return (
    <header class="statusbar">
      <Show when={props.icon}>
        {(icon) => <span class="statusbar-icon" aria-hidden="true">{icon()}</span>}
      </Show>
      <Show when={props.avatar}>
        {(avatar) => (
          <Avatar
            seed={avatar().seed}
            name={avatar().name}
            onClick={avatar().onClick}
            label={avatar().label}
          />
        )}
      </Show>
      <h2 class="statusbar-title" aria-label={props.heading}>{props.title}</h2>
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
