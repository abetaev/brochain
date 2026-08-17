architecture
============

brochain consists of the browser application **Vessel** and a headless bootstrap and relay peer, **Beacon**. Both are peers built on the common Network; Vessel additionally owns user-facing local services.

```text
Vessel
├── Account (Worker)
└── Session (Window)
    ├── Storage
    │   └── PeerStorage × peer identity
    ├── Network (local peer)
    │   └── Peer × connected remote identity
    │       ├── Registry RPC
    │       ├── Identity RPC
    │       └── Messaging RPC
    └── Roster

Beacon
└── Network (local peer)
    ├── Peer × connected remote identity
    │   ├── Registry RPC
    │   └── Discovery RPC
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
| **Network** | Represents the local peer, constructs remote Peers, retains one active Peer per connected identity, and owns the libp2p lifetime. | Active connections and transient connection attempts |
| **Roster** | Produces the current peer view by combining connected peers with one-hop remote Discovery results. | No retained result or discovery cache |
| **Storage** | Provides event, singleton, and key/value stores scoped first by peer identity and then by service. | Memory; discarded with the Session |

Roster performs a fresh sweep for every list request. It asks each currently connected Peer for its Registry, calls Discovery only when advertised, groups valid addresses by their terminal peer ID, and materializes each identity through Network without dialing it. Connected peers are always included. Invalid responses and failed providers are isolated so healthy partial results remain available. `getPeer` checks current connections before doing a fresh sweep.

Roster uses no Storage and retains no peer result. Its subscription forwards Network connection-topology changes only as invalidations; subscribers request a new list to obtain current data. This makes inbound and outbound connection changes visible immediately while remote Discovery changes remain explicit refreshes until that RPC service gains its own update mechanism.

### Network and Peer

Network accepts one or more multiaddresses when creating a Peer. Identity-bearing addresses produce an unretained disconnected Peer without dialing unless that identity is already connected. An address without a peer ID is authenticated by dialing and returns the active connected Peer. Local and conflicting identities are rejected.

Network retains only active Peers. Concurrent connection attempts for one identity converge on one active Peer, and `Peer.connect()` returns that representative so callers can replace a stale disconnected handle. Losing the final direct connection removes the Peer from Network; a caller-held Peer may reconnect later. Network publishes one topology transition when an identity enters or leaves this active set; Identify updates and additional connections for the same identity do not create duplicate transitions.

Peer owns the RPC services exposed to its authenticated counterpart. Mandatory Registry is installed before the per-Peer initializer selects optional services; later hosting is add-only. `Peer.service(name)` returns a transparent typed RPC projection, while Registry remains the authority for remote availability.

Inbound transport source addresses are not dialable peer addresses. Explicit authenticated dial targets and Identify or Identify Push supply retained addresses; a connected inbound Peer may therefore remain temporarily addressless and is omitted from Discovery until it advertises a listen address.

RPC projects named request/response method objects over authenticated direct connections. Service objects contain methods only and carry neither a service name nor gateway state. Remote method results are promises, values may contain JSON-compatible data and bytes, and the authenticated connection selects the requesting Peer and its permitted hosted-object map.

Vessel reaches Beacon over WebSockets and Circuit Relay v2, then uses WebRTC for direct browser-to-browser connections. `RTCPeerConnection` keeps this runtime in the Window.

### Session Storage

Storage is addressed as `peer(peerId).service(serviceName)` and then as an event, singleton, or key/value store. Local-service state uses the local `Network.id`; RPC interaction state uses the remote counterpart's ID. For example, sent and received messages with one remote peer share that peer's Messaging event store. Infrastructure state required to operate Session, Network, and Peer lifetimes remains encapsulated by those entities.

### peer RPC services

RPC services are plain method objects. They may hold their designated Service Storage and immutable configuration or read-only capabilities, but retain no mutable state themselves.

| Service | Availability | Behavior |
| --- | --- | --- |
| **Registry** | Mandatory on every Peer | Lists Registry and the optional services exposed to that authenticated counterpart. It uses no Storage or subscription. |
| **Discovery** | Optional; currently Beacon only | Lists advertised addresses of other currently connected peers. It uses no Storage. |
| **Identity** | Optional; Vessel | Publishes the local username. Callers validate results and keep the Session contact cache in the remote peer's Identity singleton store. |
| **Messaging** | Optional; Vessel | Validates text and file requests and appends received events to the authenticated counterpart's Messaging event store. |

Chat appends outgoing events before invoking remote Messaging and appends failures when calls reject. Independent calls are not sequenced. Message history and unread counts use the remote counterpart's Messaging event store and named read singleton. They survive navigation within one Session and disappear when that Session ends.

### UI

- **dependencies**: Account and the active Session
- **behavior**:
  - **Account** — create, unlock, export, and delete accounts
  - **Home** — subscribes to Roster invalidations, requests a fresh list on render, local connection changes, and explicit refresh, connects peers, gates actions through Registry, shows connection and unread state, reports bootstrap status, and signs out
  - **Chat** — resolves navigation peer IDs through Roster, calls transparent Identity and Messaging services, displays Storage events, and records read counts in Storage
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
