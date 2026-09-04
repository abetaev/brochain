import type { JSX } from "solid-js";
import { Avatar } from "@v/frontend/components/Avatar";
import { selfBubbleColor, peerBubbleColor } from "@v/frontend/components/colors";
import "./Feed.css";

export function Feed(props: { children: JSX.Element }) {
  return (
    <ul class="feed" aria-live="polite">
      {props.children}
    </ul>
  );
}

// A message reads as one shape: the avatar caps the row on the sender's side,
// flush against the bubble, and the bubble takes the rest of the width.
export function FeedEntry(props: {
  direction: "sent" | "received";
  avatarSeed: string;
  avatarName: string;
  children: JSX.Element;
}) {
  const sent = () => props.direction === "sent";

  return (
    <li class="feed-entry" data-direction={props.direction}>
      <Avatar
        seed={props.avatarSeed}
        name={props.avatarName}
        shape={sent() ? "tag-end" : "tag-start"}
      />
      <article
        class="bubble"
        style={{ background: sent() ? selfBubbleColor : peerBubbleColor(props.avatarSeed) }}
      >
        {props.children}
      </article>
    </li>
  );
}
