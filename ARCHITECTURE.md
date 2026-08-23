architecture
============

This document describes the implemented technical architecture of brochain.

brochain consists of the browser application **Vessel**, the reusable
**Common** backend, and the headless bootstrap and relay peer **Beacon**.

structure
---------

```text
Common
└── Backend
    └── Network
        ├── Peer
        ├── RPC and ByteStream
        └── Registry and Discovery

Vessel
├── Backend
│   ├── Account
│   └── Session
│       ├── Signals
│       ├── Storage
│       │   ├── Volatile
│       │   │   └── PeerStorage × peer identity
│       │   │       └── ServiceStorage × service
│       │   │           └── Event, singleton, key/value, and file stores
│       │   └── Persistent
│       │       └── PeerStorage × peer identity
│       │           └── ServiceStorage × service
│       │               └── Key/value stores
│       └── Network
│           ├── Common Network
│           └── Identity, Messaging, and DataTransfer services
└── Frontend
    ├── Services
    │   ├── Roster
    │   └── Chat
    └── Views
        ├── Account
        ├── Home
        └── Chat

Beacon
└── Common Network
    ├── Registry and Discovery
    └── Circuit relay
```

Backend and frontend are dependency layers, not separate deployments. Both
Vessel layers run in the browser, with Account operations isolated in a Worker.
Vessel and Beacon compose the same Common Network implementation. The `@v` and
`@c` aliases are build-time conveniences for Vessel; Common and Beacon use
explicit relative imports so Beacon remains directly executable by Node.js.

Common
------

### Backend

#### Network

- **dependencies**: a configured libp2p node
- **behavior**: represents one local peer, creates and connects remote Peers,
  owns active connections, and hosts an add-only catalog of named services
- **structure**: Network owns active Peer entities, RPC projection, byte-stream
  protocols, Registry, and optional Discovery
- **technology**: libp2p connections and events; typed-rpc request/response
  projection

Network accepts one or more multiaddresses when creating a Peer. An address
which identifies a remote peer can produce a disconnected Peer without dialing;
an unidentified address is authenticated by connecting. Concurrent attempts for
one identity converge on one active Peer. Losing the final direct connection
removes that Peer from Network, while a caller-held Peer may reconnect later.

Network publishes topology changes through its own observer. This observer is
part of standalone Common infrastructure and does not depend on Vessel Signals.

The service catalog may attach an RPC factory, byte-stream protocols, or both to
one service name. Registry reports the subset currently available to an
authenticated peer. Availability is checked for every RPC request and inbound
byte stream.

##### Peer

- **dependencies**: its owning Network and an authenticated remote identity
- **behavior**: connects or reconnects that identity, exposes current addresses
  and connection state, projects remote RPC services, and opens byte streams
- **structure**: one public Peer represents the Network's current connection to
  one remote identity; its local observer reports connection transitions

`Peer.service(name)` returns a typed RPC projection. `Peer.open(protocol)`
returns a project-owned `ByteStream` with asynchronous reads, backpressured
writes, graceful half-close, and abort. Libp2p stream types do not cross the
Common Network boundary.

Explicit dial targets and Identify supply retained addresses. Inbound transport
source addresses are not treated as dialable; an inbound Peer may therefore be
temporarily addressless and omitted from Discovery.

##### Registry

- **dependencies**: Network service catalog
- **behavior**: lists the services currently available to the requesting peer
- **structure**: mandatory RPC service on every Peer

##### Discovery

- **dependencies**: Network and its connected Peers
- **behavior**: lists advertised addresses for other connected peers
- **structure**: optional RPC service; currently hosted by Beacon

RPC service facets are plain method objects. Remote results are promises, values
may contain JSON-compatible data and bytes, and the authenticated connection
selects the requesting Peer and its permitted services.

Vessel
------

### Backend

#### Account

- **dependencies**: browser IndexedDB, Web Crypto, and a Session factory after
  successful authentication
- **behavior**: lists, creates, unlocks, exports, and password-confirms deletion
  of local accounts; creation and unlocking produce an authenticated Session;
  deletion removes the account's persistent Storage database before its account
  record
- **structure**: a Window facade serializes authentication and projects the
  account service running in a Worker; decrypted identity material remains
  behind the private Session boundary
- **technology**: Comlink Worker RPC, IndexedDB, PBKDF2, and AES-GCM

The `brochain` IndexedDB database stores only versioned encrypted account
records. Password handling, decryption, derived keys, and the peer identity seed
remain in the Worker; the public Account API exposes no identity material.
After password validation, deletion removes `brochain/<username>` and removes
the account record only when that succeeds.

#### Session

- **dependencies**: one unlocked Account identity and the browser networking
  runtime
- **behavior**: provides stable account-bound Signals, volatile and persistent
  Storage roots, and Network; maintains default-peer bootstrap and owns their
  common shutdown
- **structure**: one Session composes one instance of each core component and
  closes Network, Storage, and Account access together
- **runtime**: browser Window

Network startup is independent of connection to the inferred default bootstrap
peer. Failure leaves a usable offline Network and is retried on later Network
access. Successful bootstrap waits for a relay-backed WebRTC address. Sign-out
aborts bootstrap, closes networking, removes Session files, and closes Account
access.

##### Signals

- **dependencies**: its owning Session only
- **behavior**: integrates independently extensible network services, frontend
  services, and views through typed component-owned channels
- **structure**: channel identity combines the Signals instance, owner identity,
  and local channel name; subscriptions and channel lookup remain Session-local

Publication is synchronous, ordered, non-retained, and non-replaying. A
subscriber which throws synchronously is logged without event payload data and
does not affect the publisher or later subscribers. Subscriber return values are
ignored, and subscribers own failures from asynchronous work they start.
Platform events, request/response flows, Common Network observers, and
component-local reactivity remain outside Signals.

##### Storage

- **dependencies**: its owning Session and account username; browser IndexedDB
  for persistence; OPFS and Web Locks only when a file store is first used
- **behavior**: selects volatile or persistent retention while preserving one
  stable peer, service, kind, and optional-name hierarchy per mode
- **structure**: one public root composes in-memory structured stores, one shared
  Session file root, and one independent per-account persistent backend
- **technology**: in-memory collections for volatile structured stores;
  IndexedDB structured cloning for persistent values; OPFS, Storage quota
  estimates, and Web Locks for volatile files

`session.storage()` and `session.storage({ persistent: false })` return the same
volatile root. Its synchronous event, singleton, key/value, and asynchronous file
stores retain data for the Session lifetime. `session.storage({ persistent:
true })` returns a separate stable root whose initial store kind is asynchronous
key/value. Persistent values are stored without encryption and survive Session
shutdown.

Persistent IndexedDB access opens `brochain/<username>` lazily and a failed
attempt may be retried by a later operation. Storage owns this database and does
not read Account data. Entries are immutable snapshots in ascending IndexedDB
key order; default and explicitly empty store names remain distinct. A database
version change closes and invalidates an open persistent root. Closing Storage
waits for accepted operations and closes database access without deleting
persistent values.

Storage exposes no notification API. A component which signals a retained
mutation MUST update Storage before publishing the corresponding event.
Interaction state is scoped by the remote peer ID; local-service state uses the
local Network identity.

All file stores share one lazily initialized Session OPFS root and quota
accounting. Writers declare an exact size, preserve backpressure, and expose a
completed value as an opaque Blob. Ten percent of browser quota is reserved.
Web Locks protect active tabs while abandoned Session directories are removed.
Closing Storage waits for pending initialization and file creation, aborts active
writers, removes the Session directory, and releases its lock.

##### Network

- **dependencies**: the Session identity and Common Network
- **behavior**: connects Vessel to other peers and provides the services used by
  frontend composition
- **structure**: Session configures one Common Network and services attach their
  RPC or byte-stream facets through its catalog
- **technology**: libp2p WebSockets and Circuit Relay v2 for bootstrap, WebRTC
  for direct browser connections, Noise encryption, Yamux multiplexing, and
  Identify

###### Identity

- **dependencies**: Session account name
- **behavior**: returns `{ name }` for the local peer; callers validate and
  cache the response
- **structure**: optional RPC service

###### Messaging

- **dependencies**: Session Network and Signals
- **behavior**: sends validated opaque-ID text messages and publishes peer-tagged
  sent, received, and failed events
- **structure**: one Session-bound entity with an RPC facet and event channel; it
  retains no Chat state

###### DataTransfer

- **dependencies**: Session Network and Signals
- **behavior**: streams declared-length binary data after explicit receiver
  acceptance and publishes offer, progress, completion, and failure events
- **structure**: one Session-bound entity with the
  `/brochain/data-transfer/1.0.0` byte-stream protocol and an ordered event
  channel

DataTransfer validates bounded JSON metadata before accepting bytes, enforces
the declared length and two streams per direction per peer, preserves
backpressure, and requires a final acknowledgement. A consumer MUST claim an
offer during synchronous publication by supplying a sink or sink promise.
Unclaimed offers are rejected. Progress is published no more than once per 250
milliseconds plus its final state; interrupted transfers do not resume.

### Frontend

- **dependencies**: Account and an active Session
- **behavior**: presents account management, peer connection, messaging, file
  transfer, unread state, and navigation
- **structure**: application composition creates Chat and Roster services for an
  authenticated Session and passes them to complete views
- **technology**: SolidJS, Pico CSS, and a Vite-generated PWA shell

#### Services

##### Roster

- **dependencies**: Session Network and Signals; remote Registry and optional
  Discovery services
- **behavior**: returns the current connected and discovered peers and resolves a
  requested peer; publishes invalidations when local topology changes
- **structure**: one Session-bound service performs a fresh discovery sweep for
  each list request and bridges the Common Network observer to one Signals
  channel

Roster retains no peer projection. It asks each connected peer for Registry,
uses Discovery only when advertised, groups valid addresses by remote identity,
and creates disconnected Peers without dialing them. Provider failures and
invalid results are isolated so healthy partial results remain available.

##### Chat

- **dependencies**: Session Storage and Signals, Messaging, DataTransfer, and
  remote Registry
- **behavior**: retains chat history and unread counts, sends text and files,
  accepts incoming files, exposes text/file capability, and publishes complete
  presentation updates
- **structure**: one Session-bound frontend service composes both transports with
  peer- and Chat-scoped stores and its update and read channels

Chat retains ordered item IDs and item snapshots before publishing updates.
Received files stream into its file store; Chat alone assigns their display name
and media type. Text capability gates Chat, while DataTransfer capability gates
file controls independently. History and unread counts survive view navigation
and disappear when Session ends.

#### Views

##### Account

- **dependencies**: Account backend facade
- **behavior**: creates, unlocks, exports, and deletes accounts and shows advisory
  password strength
- **structure**: one complete account-management view
- **technology**: SolidJS and zxcvbn

##### Home

- **dependencies**: Session, Roster, Chat, and Identity
- **behavior**: lists and refreshes peers, connects them, shows unread and
  connection state, opens Chat, and signs out
- **structure**: one complete signed-in landing view with reusable peer rows
- **technology**: SolidJS resources and signals

##### Chat

- **dependencies**: Session, Roster, Chat service, and Identity
- **behavior**: displays peer information and retained items, sends messages and
  files, downloads received files, and marks received items read
- **structure**: one complete conversation view with file presentation
- **technology**: SolidJS resources and signals

```text
Account --create/unlock--> Home --open peer ID--> Chat
Account <--sign out------- Home <--back----------- Chat
```

Beacon
------

### Network

- **dependencies**: Common Network and configured public relay information
- **behavior**: bootstraps peers, relays connection establishment, and lets
  connected peers discover one another
- **structure**: one headless Common Network hosts Registry, Discovery, and a
  Circuit Relay without application message storage
- **runtime**: Node.js
- **technology**: libp2p, WebSockets, Circuit Relay v2, Noise, Yamux, Identify,
  and Identify Push

Development starts Beacon beside Vessel. Production serves the built Vessel and
runs Beacon in the same process.
