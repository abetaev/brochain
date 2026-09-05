import { Show } from "solid-js";
import "./Badge.css";

type Connection = "connected" | "disconnected" | "unavailable";

const connectionLabel: Record<Connection, string> = {
  connected: "Connected",
  disconnected: "Disconnected",
  unavailable: "Unavailable",
};

// A badge hangs off an avatar at the position its meaning owns: unread messages
// at 1 o'clock, a call at 5 o'clock. Position follows from the variant, so it
// can't drift between screens. Connection state takes the call's position, since
// a call implies a connection and the two are never both true.
export function Badge(
  props:
    | { variant: "unread" | "call"; mode?: "incoming" | "ongoing" }
    | { variant: "connection"; state: Connection },
) {
  const connection = () => props.variant === "connection" ? props.state : undefined;
  const mode = () => props.variant === "connection" ? undefined : props.mode;

  // A decorative badge repeats what its avatar already says; connection state is
  // said nowhere else, so that badge is named rather than hidden.
  return (
    <Show
      when={connection()}
      fallback={
        <span class="badge" data-variant={props.variant} data-mode={mode()} aria-hidden="true">
          {props.variant === "unread" ? "🗨️" : "📞"}
        </span>
      }
    >
      {(state) => (
        <span
          class="badge"
          data-variant="connection"
          data-state={state()}
          aria-label={connectionLabel[state()]}
        />
      )}
    </Show>
  );
}
