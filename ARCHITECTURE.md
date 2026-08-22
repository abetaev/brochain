architecture
============

This document describes technical architecture of the project as well as its structure and behavior.

brochain consists of the browser application **Vessel** and a headless bootstrap and relay peer, **Beacon**. Both are peers built on the Common backend Network; Vessel additionally separates its account-bound backend core components from its frontend services and views.

```text
Vessel
├── Backend
│   ├── Account (Worker)
│   └── Session (Window)
│       ├── Signals
│       ├── Storage
│       │   └── PeerStorage × peer identity
│       └── Network (local peer)
│           └── Peer × connected remote identity
│               ├── Registry RPC
│               ├── Identity RPC
│               └── Messaging RPC
└── Frontend (Window)
    ├── Services
    │   └── Roster
    └── Views
        ├── Account
        ├── Home
        └── Chat

Common
└── Backend
    └── Network, Peer, RPC, Registry, and Discovery

Beacon
└── Network (local peer)
    ├── Peer × connected remote identity
    │   ├── Registry RPC
    │   └── Discovery RPC
    └── Circuit relay
```

Backend and frontend are dependency layers, not separate deployments: both Vessel layers run in the browser, with Account isolated in a Worker. Frontend services and views depend on Vessel's backend core components, and Vessel and Beacon both depend on Common's backend Network implementation. The `@v` and `@c` aliases are build-time conveniences for Vessel; Common and Beacon retain explicit relative imports so Beacon remains directly executable by Node.js.

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
- **behavior**: owns one Network, Signals, and Storage lifetime; stable accessors initialize and maintain these account-bound core components so consumers do not coordinate their construction, bootstrap, retry, or shutdown
- **bootstrap**: Network startup is independent of the inferred default-Beacon connection. Bootstrap failure leaves a usable offline Network, records an error for Home, and is retried by later Network access, including requests made by Roster, whenever Beacon is disconnected. Successful bootstrap waits for the relay-backed WebRTC address.
- **shutdown**: sign-out closes peer networking and the Account session

### Session core components

| Entity | Responsibility | State |
| --- | --- | --- |
| **Network** | Represents the local peer, constructs remote Peers, retains one active Peer per connected identity, and owns the libp2p lifetime. | Active connections and transient connection attempts |
| **Signals** | Resolves component-owned typed channels by owner identity and local name. Lookups are stable within one Session, while different owners and Sessions remain isolated. Channels synchronously publish data to subscribers in subscription order and fail on the first subscriber error. | Channel identities and subscriptions; events are neither retained nor replayed |
| **Storage** | Provides event, singleton, and key/value stores scoped first by peer identity and then by service. | Memory; discarded with the Session |

Components expose their actual owned channels through their public contracts, so publishers and subscribers integrate through the contract without depending on one another's implementations.

### Network and Peer

Network accepts one or more multiaddresses when creating a Peer. Identity-bearing addresses produce an unretained disconnected Peer without dialing unless that identity is already connected. An address without a peer ID is authenticated by dialing and returns the active connected Peer. Local and conflicting identities are rejected.

Network retains only active Peers. Concurrent connection attempts for one identity converge on one active Peer, and `Peer.connect()` returns that representative so callers can replace a stale disconnected handle. Losing the final direct connection removes the Peer from Network; a caller-held Peer may reconnect later. Network publishes one topology transition when an identity enters or leaves this active set; Identify updates and additional connections for the same identity do not create duplicate transitions.

Peer owns the RPC services exposed to its authenticated counterpart. Mandatory Registry is installed before the per-Peer initializer selects optional services; later hosting is add-only. `Peer.service(name)` returns a transparent typed RPC projection, while Registry remains the authority for remote availability.

Inbound transport source addresses are not dialable peer addresses. Explicit authenticated dial targets and Identify or Identify Push supply retained addresses; a connected inbound Peer may therefore remain temporarily addressless and is omitted from Discovery until it advertises a listen address.

RPC projects named request/response method objects over authenticated direct connections. Service objects contain methods only and carry neither a service name nor gateway state. Remote method results are promises, values may contain JSON-compatible data and bytes, and the authenticated connection selects the requesting Peer and its permitted hosted-object map.

Vessel reaches Beacon over WebSockets and Circuit Relay v2, then uses WebRTC for direct browser-to-browser connections. `RTCPeerConnection` keeps this runtime in the Window.

### Session Storage

Storage is addressed as `peer(peerId).service(serviceName)` and then as an event, singleton, or key/value store. It only retains and retrieves projections and exposes no notification API. A domain that signals a mutation MUST update Storage successfully before publishing the corresponding data-bearing event. Local-service state uses the local `Network.id`; RPC interaction state uses the remote counterpart's ID. For example, sent and received messages with one remote peer share that peer's Messaging event store. Infrastructure state required to operate Session, Network, and Peer lifetimes remains encapsulated by those entities.

### peer RPC services

RPC services are plain method objects. They may hold their designated Service Storage and immutable configuration or read-only capabilities, but retain no mutable state themselves.

| Service | Availability | Behavior |
| --- | --- | --- |
| **Registry** | Mandatory on every Peer | Lists Registry and the optional services exposed to that authenticated counterpart. It uses no Storage or subscription. |
| **Discovery** | Optional; currently Beacon only | Lists advertised addresses of other currently connected peers. It uses no Storage. |
| **Identity** | Optional; Vessel | Publishes the local username. Callers validate results and keep the Session contact cache in the remote peer's Identity singleton store. |
| **Messaging** | Optional; Vessel | Validates text and file requests, appends received events to the authenticated counterpart's Messaging event store, and then publishes the exact peer-tagged event. |

One Messaging entity is constructed from the active Session. It resolves its
Signals channels and Storage scopes, hosts an identity-bound RPC adapter on
each connected Peer, and owns incoming and outgoing message retention. Its
public interface provides history and read-count projections, outgoing text and
file operations, one ordered `events` channel containing complete sent,
received, and failed events, and a `reads` channel containing peer-tagged read
counts. Every mutation is retained before publication; outgoing delivery
failures are retained and published after the sent event. Message history and
unread counts survive navigation within one Session and disappear when that
Session ends. Independent calls are not sequenced.

### Frontend

- **dependencies**: Account and the active Session
- **services**: application composition creates one Messaging entity and one Roster for an authenticated Session; both use Session's core components without becoming Session dependencies
- **behavior**:
  - **Account** — create, unlock, export, and delete accounts
  - **Home** — subscribes to Roster invalidations and Messaging channels, requests a fresh peer list on render, local connection changes, and explicit refresh, connects peers, gates actions through Registry, shows connection and unread state, reports bootstrap status, and signs out
  - **Chat** — resolves navigation peer IDs through Roster, calls Identity, sends through Messaging, displays its retained and newly signaled events, and marks received messages as read through the same entity
- **technology**: SolidJS, Pico CSS, advisory zxcvbn password strength, and a Vite-generated PWA shell

Roster performs a fresh sweep for every list request. It asks each currently connected Peer for its Registry, calls Discovery only when advertised, groups valid addresses by their terminal peer ID, and materializes each identity through Network without dialing it. Connected peers are always included. Invalid responses and failed providers are isolated so healthy partial results remain available. `getPeer` checks current connections before doing a fresh sweep.

Roster uses no Storage and retains no peer result. Its subscription forwards Network connection-topology changes only as invalidations; subscribers request a new list to obtain current data. This makes inbound and outbound connection changes visible immediately while remote Discovery changes remain explicit refreshes until that RPC service gains its own update mechanism.

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
