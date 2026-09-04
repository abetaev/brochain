import type { JSX } from "solid-js";

export function ButtonGroup(props: { children: JSX.Element }) {
  return <div class="button-group">{props.children}</div>;
}
