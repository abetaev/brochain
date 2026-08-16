architecture
============

brochain consists of the browser application **Vessel** and a headless bootstrap and relay peer, **Beacon**. Both are peers built on the common Network; Vessel additionally owns user-facing local services.

```text
Vessel
├── Account (Worker)
└── Session (Window)
    ├── Network (local peer)
    │   ├── Registry RPC
    │   ├── Identity RPC
    │   ├── Messaging RPC
    │   └── Peer × remote identity
    ├── Roster
    └── Storage
        └── PeerStorage × remote identity

Beacon
└── Network (local peer)
    ├── Registry RPC
    ├── Discovery RPC
    └── Circuit relay
```

Vessel
------

### Account

- **runtime**: Web Worker; Comlink projects its API into the Window
- **behavior**: list, create, unlock, export, and password-confirmed deletion of local accounts; create and unlock produce a Session
- **storage**: IndexedDB holds v2 account records; PBKDF2 and AES-GCM protect the peer identity seed
- **boundary**: password handling, account decryption, and derived keys remain in the Worker; the public Account API exposes no identity material, while the active Session receives its identity seed through a private endpoint

### Session

- **runtime**: Window
- **dependency**: one unlocked Account identity
- **behavior**: owns one Network, Roster, and Storage lifetime; stable accessors initialize and maintain these dependencies so views do not coordinate construction, bootstrap, retry, or shutdown
- **bootstrap**: Network startup is independent of the inferred default-Beacon connection. Bootstrap failure leaves a usable offline Network, records an error for Home, and is retried by later Network or Roster access whenever Beacon is disconnected. Successful bootstrap waits for the relay-backed WebRTC address.
- **shutdown**: sign-out closes peer networking and the Account session

### stateful local entities

| Entity | Responsibility | State |
| --- | --- | --- |
| **Network** | Represents the local peer, constructs canonical remote Peers, tracks current direct connections, hosts RPC services, and owns the libp2p lifetime. | Remote identity/address associations and connection topology for the Session |
| **Roster** | Produces the current peer view by combining connected peers with one-hop remote Discovery results. | No retained result or discovery cache |
| **Storage** | Provides event and current-value stores scoped by remote peer and service. | Memory; discarded with the Session |

Roster performs a fresh sweep for every list request. It asks each currently connected Peer for its Registry, calls Discovery only when advertised, and materializes identity-bearing results through Network without dialing them. Connected peers are always included. Invalid responses and failed providers are isolated so healthy partial results remain available. Roster topology subscriptions forward Network connection changes; `getPeer` checks current connections before doing a fresh sweep.

### Network and Peer

Network accepts one or more multiaddresses when creating a Peer. An identity-bearing address creates or updates the canonical disconnected Peer without dialing. An address without a peer ID is authenticated by dialing and returns an already-connected Peer. Addresses merge only after they resolve to the same authenticated identity; local and conflicting identities are rejected.

Network exposes current connections as a function and emits topology changes, but does not expose its private canonical peer map as a retained registry. Peer exposes dynamic address and connection accessors, explicit connection, connection notifications, and named RPC service gateways. Remote capabilities are queried through Registry rather than stored on Peer.

RPC projects named request/response services over authenticated direct connections. Values may contain JSON-compatible data and bytes. The authenticated connection supplies caller identity to hosted handlers.

Vessel reaches Beacon over WebSockets and Circuit Relay v2, then uses WebRTC for direct browser-to-browser connections. `RTCPeerConnection` keeps this runtime in the Window.

### peer RPC services

RPC service definitions contain an immutable name, a stateless hosted implementation factory, and, when needed, a peer-local gateway factory. Interaction state is not retained by an RPC service object; handlers and gateways read or mutate a separate Storage layer.

| Service | Availability | Behavior |
| --- | --- | --- |
| **Registry** | Mandatory on every Network | Lists Registry and every optional RPC service hosted by the peer. |
| **Discovery** | Optional; currently Beacon only | Lists addresses of currently connected peers other than the authenticated requester. |
| **Identity** | Optional; Vessel | Publishes the local username; its gateway validates and caches a remote username in peer-scoped Storage. |
| **Messaging** | Optional; Vessel | Accepts validated text and files. Incoming handlers append received events to Storage; the gateway records outgoing events immediately, sequences delivery per peer, and records failures there. |

Message history and unread counts use the Messaging event and value stores in peer-scoped Storage. They survive navigation within one Session and disappear when that Session ends.

### UI

- **dependencies**: Account and the active Session
- **behavior**:
  - **Account** — create, unlock, export, and delete accounts
  - **Home** — requests live Roster results, explicitly connects peers, gates actions through Registry, shows connection and unread state, reports bootstrap status, and signs out
  - **Chat** — resolves navigation peer IDs through Roster, sends and displays one messaging-capable peer's text and files, and records read counts in Storage
- **technology**: SolidJS, Pico CSS, advisory zxcvbn password strength, and a Vite-generated PWA shell

```text
Account --create/unlock--> Home --open peer ID--> Chat
Account <--sign out------- Home <--back----------- Chat
```

Beacon
------

- **runtime**: Node.js
- **behavior**: composes the common Network with optional Discovery and Circuit Relay; it stores neither application messages nor a separate application registry
- **technology**: libp2p, WebSockets, Circuit Relay v2, Noise, Yamux, Identify, and Identify Push
- **operation**: development starts Beacon beside Vessel; production serves the built Vessel and runs Beacon in the same process
