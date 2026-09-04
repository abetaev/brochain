import type { JSX } from "solid-js";

export function AppBar(props: { position: "top" | "bottom"; children: JSX.Element }) {
  const className = `appbar appbar-${props.position}`;
  return props.position === "top"
    ? <header class={className}>{props.children}</header>
    : <footer class={className}>{props.children}</footer>;
}
