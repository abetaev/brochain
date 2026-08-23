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
│       ├── Data storage (OPFS)
│       └── Network (local peer)
│           ├── Service catalog
│           └── Peer × connected remote identity
│               ├── Registry, Identity, and Messaging RPC
│               └── DataTransfer byte stream
└── Frontend (Window)
    ├── Services
    │   ├── Roster
    │   └── Chat
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
    │   └── Registry and Discovery RPC
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
- **behavior**: owns one Network, Signals, structured Storage, and lazily initialized data-storage lifetime; stable accessors initialize and maintain these account-bound dependencies so consumers do not coordinate their construction, bootstrap, retry, or shutdown
- **bootstrap**: Network startup is independent of the inferred default-Beacon connection. Bootstrap failure leaves a usable offline Network, records an error for Home, and is retried by later Network access, including requests made by Roster, whenever Beacon is disconnected. Successful bootstrap waits for the relay-backed WebRTC address.
- **shutdown**: sign-out closes peer networking, removes Session data, and closes the Account session

### Session core components

| Entity | Responsibility | State |
| --- | --- | --- |
| **Network** | Represents the local peer, constructs remote Peers, retains one active Peer per connected identity, and owns the libp2p lifetime. | Active connections and transient connection attempts |
| **Signals** | Resolves typed channels owned by independently extensible network services, frontend services, and views. Lookups are stable within one Session, while different owners and Sessions remain isolated. Channels publish synchronously in subscription order; a subscriber that throws synchronously is logged and isolated from the publisher and other subscribers. | Channel identities and subscriptions; events are neither retained nor replayed |
| **Storage** | Provides event, singleton, and key/value stores scoped first by peer identity and then by service. | Memory; discarded with the Session |

Components expose their actual owned channels through their public contracts, so publishers and subscribers integrate through the contract without depending on one another's implementations.
Signals is not a universal pubsub mechanism: Common Network and Peer retain
their standalone observers, while platform events, request/response flows, and
component-internal reactivity remain local to their owners. Subscribers MUST
handle failures from asynchronous work started by their callbacks.

### Network and Peer

Network accepts one or more multiaddresses when creating a Peer. Identity-bearing addresses produce an unretained disconnected Peer without dialing unless that identity is already connected. An address without a peer ID is authenticated by dialing and returns the active connected Peer. Local and conflicting identities are rejected.

Network owns one add-only catalog of named services. A service may provide a
per-Peer RPC factory, byte-stream protocols, or both, and may decide whether it
is available to an authenticated Peer. Registry is mandatory and dynamically
reports the enabled service names from this catalog. Availability is rechecked
for every RPC request and inbound byte stream.

Network retains only active Peers. Concurrent connection attempts for one identity converge on one active Peer, and `Peer.connect()` returns that representative so callers can replace a stale disconnected handle. Losing the final direct connection removes the Peer from Network; a caller-held Peer may reconnect later. Network publishes one topology transition when an identity enters or leaves this active set; Identify updates and additional connections for the same identity do not create duplicate transitions.

`Peer.service(name)` returns a transparent typed RPC projection.
`Peer.open(protocol)` returns a project-owned `ByteStream` over the active
authenticated direct connection. `ByteStream` provides asynchronous reads,
backpressure-aware writes, graceful half-close, and abort while keeping libp2p
stream types inside Common Network. Registry remains the authority for remote
service availability.

Inbound transport source addresses are not dialable peer addresses. Explicit authenticated dial targets and Identify or Identify Push supply retained addresses; a connected inbound Peer may therefore remain temporarily addressless and is omitted from Discovery until it advertises a listen address.

RPC projects named request/response method objects over authenticated direct connections. Service objects contain methods only and carry neither a service name nor gateway state. Remote method results are promises, values may contain JSON-compatible data and bytes, and the authenticated connection selects the requesting Peer and its permitted service facets.

Vessel reaches Beacon over WebSockets and Circuit Relay v2, then uses WebRTC for direct browser-to-browser connections. `RTCPeerConnection` keeps this runtime in the Window.

### Session Storage

Storage is addressed as `peer(peerId).service(serviceName)` and then as an event, singleton, or key/value store. It only retains and retrieves projections and exposes no notification API. A domain that signals a mutation MUST update Storage successfully before publishing the corresponding data-bearing event. Local-service state uses the local `Network.id`; interaction state uses the remote counterpart's ID. For example, sent and received items with one remote peer share that peer's Chat stores. Infrastructure state required to operate Session, Network, and Peer lifetimes remains encapsulated by those entities.

Session data storage is separate from structured Storage. It accepts a declared
size before opening an OPFS writer, streams bytes without retaining the complete
value in application memory, and exposes a stored value as a `File` only when a
consumer opens it. It reserves ten percent of browser quota and uses Web Locks
to avoid deleting another tab's active Session while removing abandoned Session
directories. Closing Session aborts active writers and removes all of its files.

### peer services

RPC facets are plain method objects. Network constructs them for the authenticated Peer from the owning service definition.

| Service | Availability | Behavior |
| --- | --- | --- |
| **Registry** | Mandatory on every Peer | Lists Registry and the optional services exposed to that authenticated counterpart. It uses no Storage or subscription. |
| **Discovery** | Optional; currently Beacon only | Lists advertised addresses of other currently connected peers. It uses no Storage. |
| **Identity** | Optional; Vessel | Publishes the local username. Callers validate results and keep the Session contact cache in the remote peer's Identity singleton store. |
| **Messaging** | Optional; Vessel | Validates and transports opaque-ID text messages. Its Session-bound entity sends text and publishes peer-tagged sent, received, and failed lifecycle events without retaining Chat state. |
| **DataTransfer** | Optional; Vessel | Streams declared-length binary data over `/brochain/data-transfer/1.0.0` after explicit receiver acceptance. Bounded JSON metadata precedes the bytes; exact length, backpressure, final acknowledgement, and two streams per direction and peer are enforced. |

One DataTransfer entity is constructed from the active Session. Its ordered
event channel carries offers, progress, completion, and failure. A consumer MUST
claim an offer during synchronous publication by supplying a sink or sink
promise; otherwise the offer is rejected. Progress is emitted no more than once
per 250 milliseconds plus its final state. Interrupted transfers do not resume.

### Frontend

- **dependencies**: Account and the active Session
- **services**: application composition creates one Chat and one Roster for an authenticated Session. Chat internally constructs Messaging and DataTransfer and combines their events with Storage and Signals.
- **behavior**:
  - **Account** — create, unlock, export, and delete accounts
  - **Home** — subscribes to Roster invalidations and Chat projection channels, requests a fresh peer list on render, local connection changes, and explicit refresh, connects peers, gates actions through Registry, shows connection and unread state, reports bootstrap status, and signs out
  - **Chat** — resolves navigation peer IDs through Roster, calls Identity, displays Chat's retained projection, sends text through Messaging and files through DataTransfer, shows transfer progress and failure, and marks received items as read
- **technology**: SolidJS, Pico CSS, advisory zxcvbn password strength, and a Vite-generated PWA shell

Roster performs a fresh sweep for every list request. It asks each currently connected Peer for its Registry, calls Discovery only when advertised, groups valid addresses by their terminal peer ID, and materializes each identity through Network without dialing it. Connected peers are always included. Invalid responses and failed providers are isolated so healthy partial results remain available. `getPeer` checks current connections before doing a fresh sweep.

Roster uses no Storage and retains no peer result. It consumes Common Network's
standalone topology observer and publishes those changes through its
Session-owned Signals invalidation channel. Consumers perform an initial list
request and request another list after an invalidation. This makes inbound and
outbound connection changes visible immediately while remote Discovery changes
remain explicit refreshes until that RPC service gains its own update mechanism.

Chat owns the Session's presentation-oriented history, full-item update channel,
and read-count channel. It retains ordered item IDs and current item snapshots in
structured Storage before publishing an update. Received files are accepted
into Session data storage. Text capability gates Chat itself; DataTransfer
capability independently gates file controls. History and unread counts survive
navigation and disappear when Session ends.

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
