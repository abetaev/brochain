import { registryServiceName } from "@c/backend/network/services/registry";
import {
  decidesAutoConnect,
  isAutoConnectEnabled,
  observeAutoConnect,
  setAutoConnect,
} from "@v/backend/options/auto-connect";
import type { Session } from "@v/backend/session";
import type { Roster, RosterEntry } from "@v/frontend/services/roster";

// Reaching a marked peer whenever it becomes available, which is what the Roster
// holds an address for: a peer the Beacon advertises again after it was gone is
// reached, while one either side disconnected keeps the address it was reached at
// and so is left as it was until it goes and returns.
export function startAutoConnect(session: Session, roster: Roster): void {
  const network = session.network();
  const options = session.options();
  const available = new Set<string>();
  const marks = new Map<string, () => void>();
  let awaitingFirst = roster.list().length === 0;

  async function reach(entry: RosterEntry | undefined): Promise<void> {
    if (entry === undefined || entry.online) return;
    const [address, ...alternates] = entry.addresses;
    if (address === undefined || !isAutoConnectEnabled(options, entry.peerId)) return;

    try {
      await network.connect(address, ...alternates);
    } catch {
      // A peer which cannot be reached now is reached when it is advertised again.
    }
  }

  // Any entity may mark a peer, so the option is watched rather than read once.
  function observeMark(peerId: string): void {
    if (marks.has(peerId)) return;
    marks.set(
      peerId,
      observeAutoConnect(options, peerId, (enabled) => {
        if (enabled === true) void reach(roster.get(peerId));
      }),
    );
  }

  function consider(entry: RosterEntry): void {
    observeMark(entry.peerId);
    if (entry.addresses.length === 0) {
      available.delete(entry.peerId);
      return;
    }
    if (available.has(entry.peerId)) return;
    available.add(entry.peerId);
    void reach(entry);
  }

  // The first peer an account ever meets is the Beacon this page connects to, and
  // it is the one peer which arrives marked; every other peer starts unmarked.
  function markFirst(peerId: string): void {
    awaitingFirst = false;
    if (!decidesAutoConnect(options, peerId)) void mark(peerId, true);
  }

  async function mark(peerId: string, enabled: boolean): Promise<void> {
    try {
      await setAutoConnect(options, peerId, enabled);
    } catch {
      // A decision which cannot be retained leaves the one already held.
    }
  }

  for (const entry of roster.list()) consider(entry);
  roster.updates.subscribe((update) => {
    if (update.type === "remove") {
      available.delete(update.peerId);
      return;
    }
    consider(update.entry);
    if (awaitingFirst) markFirst(update.entry.peerId);
  });

  // A peer which stops publishing its registry has barred us, and a bar is not
  // something to be dialled through: it unmarks that peer rather than reaching it.
  network.updates.subscribe((update) => {
    if (update.type !== "services") return;
    const { peer } = update;
    if (peer.services().includes(registryServiceName)) return;
    if (isAutoConnectEnabled(options, peer.id)) void mark(peer.id, false);
  });
}
