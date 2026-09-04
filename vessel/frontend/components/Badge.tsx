import "./Badge.css";

// A badge hangs off an avatar at the position its meaning owns: unread messages
// at 1 o'clock, a call at 5 o'clock. Position follows from the variant, so it
// can't drift between screens.
export function Badge(props: {
  variant: "unread" | "call";
  mode?: "incoming" | "ongoing";
}) {
  return (
    <span class="badge" data-variant={props.variant} data-mode={props.mode} aria-hidden="true">
      {props.variant === "unread" ? "🗨️" : "📞"}
    </span>
  );
}
