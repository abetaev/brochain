import type { JSX } from "solid-js";
import { Avatar } from "@v/frontend/components/Avatar";
import { selfBubbleColor, peerBubbleColor } from "@v/frontend/components/colors";

export function Feed(props: { children: JSX.Element }) {
  return (
    <ul class="feed" aria-live="polite">
      {props.children}
    </ul>
  );
}

export function FeedEntry(props: {
  direction: "sent" | "received";
  avatarSeed: string;
  avatarName: string;
  children: JSX.Element;
}) {
  const color = () => props.direction === "sent" ? selfBubbleColor : peerBubbleColor(props.avatarSeed);

  return (
    <li class="feed-entry" data-direction={props.direction}>
      <Avatar seed={props.avatarSeed} name={props.avatarName} size="sm" />
      <article class="bubble" style={{ background: color() }}>
        {props.children}
      </article>
    </li>
  );
}
