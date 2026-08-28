architecture
============

This document describes the implemented technical architecture of brochain.

brochain consists of the browser application **Vessel**, the reusable
**Common** backend, and the headless bootstrap and relay peer **Beacon**.

structure
---------

```text
Common Network
├── Peer × remote identity
├── Registry
├── optional hosted services
└── RPC and ByteStream adapters

Vessel
├── Backend
│   ├── Account
│   │   ├── Window facade
│   │   └── Worker account service
│   └── Session
│       ├── Signals
│       ├── Options
│       ├── Storage
│       │   ├── volatile root
│       │   └── persistent root
│       └── Network
│           ├── Common Network
│           └── Identity
└── Frontend
    ├── Roster
    ├── Chat
    │   ├── Messaging
    │   └── DataTransfer
    └── Account, Home, and Chat views

Beacon
└── Common Network
    ├── Registry
    ├── Discovery
    └── Circuit Relay
```

Backend and frontend are dependency layers, not separate deployments. Both
Vessel layers run in the browser; Account operations run in a Worker. Vessel
and Beacon use the same Common Network implementation.

Common
------

### Network

- **dependencies**: valid libp2p configuration and initial hosted service
  definitions
- **structure**: one libp2p node, Peer components, a service catalog, Registry,
  and RPC and ByteStream adapters
- **use cases**: read local identity and addresses; observe address and topology
  changes; create and list Peers; add hosted services; close Network
- **behavior**: an identified address creates a disconnected Peer; an
  unidentified address is dialed to resolve its identity. Concurrent connection
  and authentication attempts for one identity converge on one active Peer.
  Losing its final direct connection removes that Peer from Network; a
  caller-held Peer may reconnect.
  Address and topology observers are synchronous and non-retained. Registry and
  incoming service access reflect the authenticated Peer's current permitted
  service subset.

#### Peer

- **dependencies**: an owning Common Network and a resolved remote identity
- **structure**: a connection observer, remote RPC projections, and a
  ByteStream factory
- **use cases**: read addresses and connection state; connect; observe
  connection changes; access RPC services; open byte streams
- **behavior**: explicit dial targets and Identify results supply retained
  addresses; inbound transport source addresses do not. RPC values may contain
  JSON-compatible data and bytes. ByteStream provides asynchronous reads,
  backpressured writes, half-close, and abort without exposing libp2p streams.

#### Registry

- **dependencies**: an owning Common Network service catalog
- **structure**: one mandatory RPC service
- **use cases**: list services available to the requesting Peer
- **behavior**: each response reflects the current permitted service subset

#### Discovery

- **dependencies**: an owning Common Network
- **structure**: one optional RPC service, currently hosted by Beacon
- **use cases**: list advertised addresses for other connected Peers
- **behavior**: only currently advertised addresses are returned

Vessel backend
--------------

### Account

- **dependencies**: browser IndexedDB and Web Crypto, a Worker, and the Session
  factory
- **structure**: a Window facade, Worker account service, and private
  Session-access channel
- **use cases**: list, create, unlock, export, and delete local accounts
- **behavior**: account records contain only versioned encrypted data;
  passwords, decrypted secrets, and the peer identity seed remain in the
  Worker. Creation and unlock create a Session. Deletion password-confirms and
  removes `brochain/<username>` before its account record. Window authentication
  calls execute directly and have no concurrent ordering contract.

### Session

- **dependencies**: an unlocked Account identity and available IndexedDB, OPFS,
  and Web Locks
- **structure**: one instance each of Signals, Storage, Vessel Network, and
  Options
- **use cases**: access Signals, Storage, Options, and Common Network; inspect
  Beacon failure; close the authenticated Session
- **behavior**: construction creates Storage, Network through its first Beacon
  attempt, then Options. Failure closes created dependencies. Options and
  Storage access are synchronous afterward; Common Network access may await a
  Beacon retry. Closing Session closes Network, Storage, and Account access;
  consumers then discard the Session and its components.

#### Signals

- **dependencies**: its owning Session
- **structure**: typed Channels keyed by owner and local name
- **use cases**: obtain a Channel; publish; subscribe; unsubscribe
- **behavior**: publication is synchronous, ordered, non-retained, and
  non-replaying. A subscriber failure is logged without event data and does not
  affect the publisher or later subscribers. Platform events, request/response
  flows, Common Network observers, and local reactivity remain outside Signals.

#### Options

- **dependencies**: the local Network identity's persistent Storage scope and
  Session Signals
- **structure**: category and object accessors plus one change Channel
- **use cases**: traverse category and object scopes; get, set, unset, and
  observe properties
- **behavior**: construction loads scalar values and removes persisted
  non-scalars. Mutations persist before updating the projection and publishing;
  failure changes neither. Concurrent mutations have no ordering contract.
  Values are strings, numbers, booleans, or `null`; `undefined` means absent.
  The TypeScript schema does not validate exact persisted scalar types. Dynamic
  object identifiers are percent-encoded. Observation is synchronous, ordered,
  non-retained, and property-specific.

#### Storage

- **dependencies**: an account username and available browser IndexedDB, OPFS,
  Storage quota estimates, and Web Locks
- **structure**: one volatile root and one persistent root; the volatile root
  contains event, singleton, key/value, and shared file stores; the persistent
  root contains IndexedDB key/value stores
- **use cases**: select retention; access peer-, service-, kind-, and name-scoped
  stores; read and mutate values; create files; close Storage
- **behavior**: construction opens both roots. Volatile data lasts for the
  Session; unencrypted persistent values survive it. Persistent entry lists are
  immutable and key-ordered. File stores share quota accounting and one
  Web-Lock-protected Session OPFS directory; writers declare exact sizes and
  expose completed Blobs while reserving ten percent of quota. Close finishes
  or aborts accepted work before releasing resources. Storage publishes no
  mutations itself.

#### Network

- **dependencies**: the Session identity, browser origin, Beacon relay
  configuration, and Common Network factory
- **structure**: one Common Network, one Identity service, and an optional
  default-Beacon Peer
- **use cases**: read local peer ID; access Common Network; inspect Beacon
  failure; close Network
- **behavior**: construction awaits one Beacon attempt. Failure is non-fatal and
  leaves Common Network available offline; later access retries. Success waits
  for a relay-backed WebRTC address. Local peer ID is synchronous after
  construction.

##### Identity

- **dependencies**: the Session account name and Vessel Network
- **structure**: one local RPC facet and one remote response validator
- **use cases**: return local `{ name }`; request and validate remote Identity
- **behavior**: Identity retains no remote data; Roster owns valid observations

##### Messaging

- **dependencies**: Session Common Network and Signals
- **structure**: one RPC service and one peer-tagged event Channel
- **use cases**: send text; observe sent, received, and failed messages
- **behavior**: messages require valid opaque IDs and text; Messaging retains no
  Chat state

##### DataTransfer

- **dependencies**: Session Common Network and Signals
- **structure**: one byte-stream protocol and one ordered event Channel
- **use cases**: offer and send declared-length data; accept with a sink; observe
  progress, completion, and failure
- **behavior**: metadata and length are validated before bytes. A receiver must
  claim an offer during synchronous publication. Transfers preserve
  backpressure, require final acknowledgement, and allow two streams per
  direction per Peer. Progress is limited to one event per 250 milliseconds plus
  the final state. Interrupted transfers do not resume.

Vessel frontend
---------------

### Application

- **dependencies**: Account and, after authentication, an active Session
- **structure**: Roster and Chat services plus one active Account, Home, or Chat
  view
- **use cases**: authenticate; sign out; navigate between account, peer list,
  and conversation views
- **behavior**: after authentication, Application constructs Chat and then
  Roster before exposing Home. Initialization failure closes the Session.

### Roster

- **dependencies**: Session Common Network, persistent Storage, and Signals
- **structure**: one persistent Identity store, peer-discovery resolver, and
  invalidation Channel
- **use cases**: list peers; get one Peer; observe topology and name
  invalidations
- **behavior**: each query combines connected, discovered, and remembered
  Peers. Registry controls whether Identity and Discovery are queried; provider
  failures are isolated. Valid Identity is persisted before its projection and
  invalidation. Display name falls back from cached Identity name to peer ID.
  Addresses, availability, discovery, and service catalogs remain transient.

### Chat

- **dependencies**: Session Storage, Common Network, and Signals
- **structure**: Messaging, DataTransfer, peer-scoped item/order/read/file
  stores, and update and read Channels
- **use cases**: inspect history, unread count, and capabilities; mark read; send
  text or files; observe item and read updates
- **behavior**: Chat retains item state before publishing updates. Incoming files
  stream into Chat's file store. Messaging capability gates text and
  DataTransfer capability gates files. Conversation state survives view
  navigation and lasts for the Session.

### Account view

- **dependencies**: Account
- **structure**: account forms, PasswordStrength, export controls, and deletion
  controls
- **use cases**: create, unlock, export, and delete accounts
- **behavior**: one busy state prevents concurrent mutations; successful
  authentication hands Session to Application

### Home view

- **dependencies**: Session, Roster, and Chat
- **structure**: one Roster resource, peer rows, and direct-connection controls
- **use cases**: refresh peers; connect a listed or direct Peer; open Chat; sign
  out
- **behavior**: Roster and Chat invalidations update peer availability,
  capabilities, and unread presentation

### Chat view

- **dependencies**: Roster and Chat
- **structure**: Roster-entry and capability resources, Chat-history projection,
  text and file controls, and file downloads
- **use cases**: return Home; read a conversation; send text or files; download
  received files
- **behavior**: the view initializes from Chat history, follows service
  invalidations, and marks existing and new received items read. It retains only
  interaction errors and subscription cleanup; Roster owns name and availability
  while Chat owns conversation data.

Beacon
------

### Network

- **dependencies**: configured public relay information, a process identity,
  and Common Network factory
- **structure**: one Common Network with Registry, Discovery, Identify, and
  Circuit Relay services
- **use cases**: accept Vessel bootstrap connections; relay connection
  establishment; advertise connected Peers
- **behavior**: Beacon retains no application messages and keeps one identity
  for its process lifetime. Development starts it beside Vessel; production runs
  it beside the built Vessel in one process. Restart creates a new identity.

runtime and technologies
------------------------

- **Common Network**: libp2p and typed-rpc
- **Vessel backend**: browser Worker, Comlink, IndexedDB, OPFS, Web Locks, Web
  Crypto, libp2p WebSockets, Circuit Relay v2, WebRTC, Noise, Yamux, and Identify
- **Vessel frontend**: SolidJS, Pico CSS, and a Vite-generated PWA shell
- **Beacon**: Node.js, libp2p WebSockets, Circuit Relay v2, Noise, Yamux,
  Identify, and Identify Push
