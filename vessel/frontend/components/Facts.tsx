import { For, Show } from "solid-js";
import { Card } from "@v/frontend/components/Card";
import "./Facts.css";

export interface Fact {
  readonly term: string;
  readonly value: string;
}

// What is known about a peer, told plainly. Peer IDs and addresses are longer
// than the box they sit in, so they clip rather than push it open, and the
// addresses fold away because they are long and rarely read.
export function Facts(props: {
  facts: readonly Fact[];
  addresses?: readonly string[];
}) {
  return (
    <Card>
      <dl class="facts">
        <For each={props.facts}>
          {(fact) => (
            <>
              <dt>{fact.term}</dt>
              <dd class="facts-clipped">{fact.value}</dd>
            </>
          )}
        </For>
      </dl>
      <Show when={props.addresses}>
        {(addresses) => (
          <details class="facts-addresses">
            <summary>Addresses</summary>
            <Show when={addresses().length > 0} fallback={<p>None known</p>}>
              <ul>
                <For each={addresses()}>
                  {(address) => <li class="facts-clipped">{address}</li>}
                </For>
              </ul>
            </Show>
          </details>
        )}
      </Show>
    </Card>
  );
}
