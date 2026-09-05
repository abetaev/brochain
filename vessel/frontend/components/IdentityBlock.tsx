import { Show, createSignal, onCleanup, type JSX } from "solid-js";
import type { Options } from "@v/backend/options";
import {
  clearDisplayName,
  displayName,
  observeDisplayName,
  setDisplayName,
} from "@v/backend/options/peer-names";
import { Avatar } from "@v/frontend/components/Avatar";
import { EditableLabel } from "@v/frontend/components/EditableLabel";
import "./IdentityBlock.css";

// A peer's name as a view holds it: whatever was chosen for it, whatever names it
// while nothing has been, and the writes that change either.
export interface PeerName {
  /** The name chosen for this peer, if one has been. */
  chosen(): string | undefined;
  /** What the peer is called right now, chosen or not. */
  shown(): string;
  save(next: string): Promise<void>;
  clear(): Promise<void>;
}

// Bound to the Option rather than read from it once, so a name changed anywhere
// — by us, by the Roster seeding it — reaches every view showing that peer.
export function createPeerName(
  options: Options,
  peerId: string,
  fallback: () => string,
): PeerName {
  const [chosen, setChosen] = createSignal(displayName(options, peerId));
  onCleanup(observeDisplayName(options, peerId, setChosen));

  return {
    chosen,
    shown: () => chosen() ?? fallback(),
    save: async (next) => await setDisplayName(options, peerId, next),
    clear: async () => await clearDisplayName(options, peerId),
  };
}

// Who a peer is, above whatever is done with them. The block owns the naming:
// showing it, changing it, and taking it back to what it was.
export function IdentityBlock(props: {
  seed: string;
  name: PeerName;
  /** Replaces clearing the chosen name, where resetting means more than that. */
  onReset?: () => Promise<void>;
  /** Called with a failure, and with nothing when a write is attempted afresh. */
  onError: (message?: string) => void;
  actions?: JSX.Element;
}) {
  async function attempt(operation: () => Promise<void>): Promise<void> {
    props.onError();
    try {
      await operation();
    } catch (reason) {
      props.onError(reason instanceof Error ? reason.message : "That name could not be set.");
    }
  }

  return (
    <figure class="identity-block">
      <Avatar seed={props.seed} name={props.name.shown()} size="lg" />
      <figcaption>
        <EditableLabel
          value={props.name.chosen() ?? ""}
          placeholder={props.name.shown()}
          inputLabel="Name for this peer"
          onSave={(next) => void attempt(async () => await props.name.save(next))}
        />
      </figcaption>
      <div class="identity-block-actions">
        <Show when={props.name.chosen() !== undefined}>
          <button
            class="text-button"
            type="button"
            onClick={() => void attempt(props.onReset ?? props.name.clear)}
          >
            Reset name
          </button>
        </Show>
        {props.actions}
      </div>
    </figure>
  );
}
