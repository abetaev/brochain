import type { JSX } from "solid-js";
import "./List.css";

export function List(props: { children: JSX.Element }) {
  return <ul class="list">{props.children}</ul>;
}
