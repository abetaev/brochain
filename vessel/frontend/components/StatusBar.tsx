import { For, Show } from "solid-js";
import { Avatar } from "@v/frontend/components/Avatar";
import { Badge } from "@v/frontend/components/Badge";
import type { Notification } from "@v/frontend/services/notifications";
import "./StatusBar.css";

// An avatar shows who wants attention; its accessible name has to say what for.
function waiting(notification: Notification): string {
  if (notification.call === "incoming") return `${notification.name} is calling`;
  if (notification.call === "ongoing") return `In a call with ${notification.name}`;
  return `Unread messages from ${notification.name}`;
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
                  label={waiting(notification)}
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
