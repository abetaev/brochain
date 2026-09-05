import type { Peer } from "@c/backend/network";
import {
  callingServiceName,
  type CallEnding,
  type CallSignal,
  type CallingService,
} from "@v/backend/network/services/calling";
import type { Session } from "@v/backend/session";
import signals from "@c/backend/signals";
import type { Subscription } from "@c/backend/signals";

export interface CallState {
  readonly peerId: string;
  readonly direction: "outgoing" | "incoming";
  readonly status: "pending" | "connecting" | "active" | "ended";
  readonly microphone: boolean;
  readonly camera: boolean;
  readonly local?: MediaStream;
  readonly remote?: MediaStream;
  readonly error?: string;
}

export interface Call {
  readonly updates: Subscription<CallState | undefined>;
  current(): CallState | undefined;
  available(peer: Peer): boolean;
  start(peer: Peer): Promise<void>;
  accept(): Promise<void>;
  decline(): void;
  end(): void;
  setMicrophone(enabled: boolean): void;
  setCamera(enabled: boolean): void;
}

// A call has nowhere to reach beyond the local network until address discovery
// lands, so no address server is configured and the browser offers what it sees.
const connectionConfiguration: RTCConfiguration = { iceServers: [] };

export function createCall(session: Session): Call {
  const updates = signals.channel<CallState | undefined>();
  const network = session.network();
  const serviceSubscriptions = new Map<string, () => void>();

  let state: CallState | undefined;
  let party: Peer | undefined;
  let connection: RTCPeerConnection | undefined;
  let capture: MediaStream | undefined;
  let invitation: string | undefined;
  let earlyCandidates: RTCIceCandidateInit[] = [];

  function attach(peer: Peer): void {
    serviceSubscriptions.get(peer.id)?.();
    serviceSubscriptions.delete(peer.id);
    // Inbound signalling reaches the instance this peer hosts, which exists
    // before its remote catalog is known.
    if (!peer.hosts(callingServiceName)) return;
    serviceSubscriptions.set(
      peer.id,
      peer.service<CallingService>(callingServiceName)
        .events.subscribe((signal) => void receive(peer, signal)),
    );
  }

  for (const peer of network.connectedPeers()) attach(peer);
  network.updates.subscribe((update) => {
    if (update.type === "disconnected") {
      serviceSubscriptions.get(update.peerId)?.();
      serviceSubscriptions.delete(update.peerId);
      if (state !== undefined && state.peerId === update.peerId) {
        finish("This peer disconnected.");
      }
    } else if (update.type === "connected" || update.type === "publication") {
      attach(update.peer);
    }
  });

  function publish(next: CallState | undefined): void {
    state = next;
    updates.publish(next);
  }

  function revise(changes: Partial<CallState>): void {
    if (state === undefined) return;
    publish({ ...state, ...changes });
  }

  function release(): void {
    for (const track of capture?.getTracks() ?? []) track.stop();
    capture = undefined;
    connection?.close();
    connection = undefined;
    party = undefined;
    invitation = undefined;
    earlyCandidates = [];
  }

  // The reader knows what they themselves did, so their own hang-up simply clears
  // the call; only what the far side or the media path did needs reporting.
  function clear(): void {
    release();
    publish(undefined);
  }

  function finish(error: string): void {
    const current = state;
    release();
    if (current === undefined) return;
    publish({ ...current, status: "ended", local: undefined, remote: undefined, error });
  }

  function tell(peer: Peer, reason: CallEnding): void {
    void peer.service<CallingService>(callingServiceName).remote.end(reason).catch(() => {});
  }

  async function record(): Promise<MediaStream> {
    const media = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    capture = media;
    return media;
  }

  function establish(peer: Peer): RTCPeerConnection {
    const peerConnection = new RTCPeerConnection(connectionConfiguration);
    connection = peerConnection;
    party = peer;

    // A closed connection may still report, and the call it belonged to is gone.
    const abandoned = () => connection !== peerConnection;

    peerConnection.addEventListener("icecandidate", ({ candidate }) => {
      if (candidate === null || abandoned()) return;
      void peer.service<CallingService>(callingServiceName)
        .remote.candidate(candidate.toJSON()).catch(() => {});
    });
    peerConnection.addEventListener("track", (event) => {
      if (abandoned()) return;
      revise({ remote: event.streams[0] });
    });
    peerConnection.addEventListener("connectionstatechange", () => {
      if (abandoned()) return;
      if (peerConnection.connectionState === "connected") revise({ status: "active" });
      else if (peerConnection.connectionState === "failed") {
        finish("A media path to this peer could not be established.");
      }
    });
    return peerConnection;
  }

  // A candidate is only meaningful once its description exists, and the invited
  // side has no description until the reader consents.
  async function admit(candidate: RTCIceCandidateInit): Promise<void> {
    if (connection === undefined || connection.remoteDescription === null) {
      earlyCandidates.push(candidate);
      return;
    }
    await connection.addIceCandidate(candidate);
  }

  async function admitEarly(peerConnection: RTCPeerConnection): Promise<void> {
    const waiting = earlyCandidates;
    earlyCandidates = [];
    for (const candidate of waiting) await peerConnection.addIceCandidate(candidate);
  }

  async function receive(peer: Peer, signal: CallSignal): Promise<void> {
    try {
      if (signal.type === "invited") {
        if (state !== undefined && state.status !== "ended") {
          tell(peer, "busy");
          return;
        }
        release();
        party = peer;
        invitation = signal.sdp;
        publish({
          peerId: peer.id,
          direction: "incoming",
          status: "pending",
          microphone: true,
          camera: true,
        });
        return;
      }
      if (state === undefined || state.peerId !== peer.id) return;
      if (signal.type === "ended") {
        finish(endingMessage(signal.reason));
        return;
      }
      if (signal.type === "candidate") {
        await admit(signal.candidate);
        return;
      }
      const peerConnection = connection;
      if (state.direction !== "outgoing" || peerConnection === undefined) return;
      await peerConnection.setRemoteDescription({ type: "answer", sdp: signal.sdp });
      await admitEarly(peerConnection);
      revise({ status: "connecting" });
    } catch (reason) {
      finish(errorMessage(reason));
    }
  }

  return {
    updates,
    current: () => state,
    available: (peer) =>
      peer.isConnected() && peer.services().includes(callingServiceName),
    async start(peer) {
      if (state !== undefined && state.status !== "ended") {
        throw new Error("Another call is already in progress.");
      }
      release();
      publish({
        peerId: peer.id,
        direction: "outgoing",
        status: "pending",
        microphone: true,
        camera: true,
      });
      try {
        if (!peer.services().includes(callingServiceName)) {
          throw new Error("Calls are unavailable with this peer.");
        }
        const media = await record();
        const peerConnection = establish(peer);
        for (const track of media.getTracks()) peerConnection.addTrack(track, media);
        await peerConnection.setLocalDescription();
        revise({ local: media });
        await peer.service<CallingService>(callingServiceName)
          .remote.invite(peerConnection.localDescription?.sdp ?? "");
      } catch (reason) {
        finish(errorMessage(reason));
      }
    },
    async accept() {
      const current = state;
      const peer = party;
      const offer = invitation;
      if (
        current?.direction !== "incoming" || current.status !== "pending" ||
        peer === undefined || offer === undefined
      ) return;
      try {
        const media = await record();
        const peerConnection = establish(peer);
        await peerConnection.setRemoteDescription({ type: "offer", sdp: offer });
        await admitEarly(peerConnection);
        for (const track of media.getTracks()) peerConnection.addTrack(track, media);
        await peerConnection.setLocalDescription();
        revise({ local: media, status: "connecting" });
        await peer.service<CallingService>(callingServiceName)
          .remote.accept(peerConnection.localDescription?.sdp ?? "");
      } catch (reason) {
        if (party !== undefined) tell(party, "declined");
        finish(errorMessage(reason));
      }
    },
    decline() {
      if (state?.status === "ended" || party === undefined) return;
      tell(party, "declined");
      clear();
    },
    end() {
      if (state === undefined || state.status === "ended" || party === undefined) return;
      tell(party, "ended");
      clear();
    },
    setMicrophone(enabled) {
      for (const track of capture?.getAudioTracks() ?? []) track.enabled = enabled;
      revise({ microphone: enabled });
    },
    setCamera(enabled) {
      for (const track of capture?.getVideoTracks() ?? []) track.enabled = enabled;
      revise({ camera: enabled });
    },
  };
}

function endingMessage(reason: CallEnding): string {
  if (reason === "declined") return "This peer declined the call.";
  if (reason === "busy") return "This peer is already in another call.";
  return "This peer ended the call.";
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error && reason.message.length > 0
    ? reason.message
    : "The call failed.";
}
