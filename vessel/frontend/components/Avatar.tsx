import { Show, type JSX } from "solid-js";
import { peerAccentColor } from "@v/frontend/components/colors";
import "./Avatar.css";

// Initials are the first letter of each word in the name, with underscores read
// as word breaks: "alice" → A, "alice_smith" → AS.
function initials(name: string): string {
  return name
    .replace(/_/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => word[0]!.toUpperCase())
    .join("");
}

export function Avatar(props: {
  /** The identity the colour is derived from, so one peer looks the same everywhere. */
  seed: string;
  name: string;
  size?: "sm" | "md" | "lg";
  /** Overrides the identity-derived colour. */
  color?: string;
  image?: string;
  /** Badges to hang off the circle, e.g. <Badge variant="unread" />. */
  badges?: JSX.Element;
  onClick?: () => void;
  /** The accessible name when clickable; defaults to the peer's name. */
  label?: string;
}) {
  const shown = () => props.name.trim().length > 0 ? props.name : props.seed;

  const circle = () => (
    <span class="avatar-circle" style={{ "--avatar-color": props.color ?? peerAccentColor(props.seed) }}>
      <Show when={props.image} fallback={initials(shown())}>
        {(image) => <img src={image()} alt="" />}
      </Show>
    </span>
  );

  return (
    <Show
      when={props.onClick}
      fallback={
        <span class="avatar" classList={{ sm: props.size === "sm", lg: props.size === "lg" }} aria-hidden="true">
          {circle()}
          {props.badges}
        </span>
      }
    >
      {(onClick) => (
        <button
          type="button"
          class="avatar"
          classList={{ sm: props.size === "sm", lg: props.size === "lg" }}
          aria-label={props.label ?? shown()}
          onClick={onClick()}
        >
          {circle()}
          {props.badges}
        </button>
      )}
    </Show>
  );
}
