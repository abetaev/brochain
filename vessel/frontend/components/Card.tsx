import type { JSX } from "solid-js";
import "./Card.css";

export function Card(props: { children: JSX.Element }) {
  return <section class="card">{props.children}</section>;
}
