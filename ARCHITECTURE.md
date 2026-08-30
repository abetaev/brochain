architecture
============

This document describes the implemented technical architecture of brochain.

brochain consists of the browser application **Vessel**, the reusable
**Common** backend, and the headless bootstrap and relay peer **Beacon**.

architecture semantics are described in [this document](./docs/ARCHITECTURE.md) and provide guidelines and patterns for project development.

structure
---------

```text
Common Network
├── Peer × remote identity
│   ├── Registry instance
│   └── enabled service instances
├── fixed Network Service Factory catalog
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
│           ├── Identity factory
│           ├── Messaging factory
│           └── DataTransfer factory
└── Frontend
    ├── Roster
    ├── Chat
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

- **dependencies**: valid libp2p configuration, a fixed Network Service Factory
  catalog, and a per-Peer publication decision
- **structure**: one libp2p node, Peer components, the fixed factory catalog,
  the standard Registry factory, and RPC and ByteStream adapters
- **use cases**: read local identity and addresses; create and list Peers;
  inspect supported services; publish or remove one service for a connected
  Peer; observe Peer connection, address, and service-catalog changes; close
  Network
- **behavior**: an identified address creates a disconnected Peer; an
  unidentified address is dialed to resolve its identity. Concurrent connection
  and authentication attempts for one identity converge on one active Peer.
  Intermediary relay connections used to establish WebRTC are ignored; only a
  completed direct connection creates and publishes a Peer.
  Connection creates the configured service instances for that Peer, then
  publishes the connected Peer. A later service-catalog refresh makes
  the first remote Registry request; a missing or invalid Registry terminates
  the Peer. Losing the final direct connection removes the Peer.
  Publication changes add or remove one peer-bound instance. New RPC calls and
  byte streams use the current published set; accepted work retains its instance
  and finishes. The factory catalog remains fixed for the Network lifetime.

#### Peer

- **dependencies**: an owning Common Network and a resolved remote identity
- **structure**: connection state, retained addresses, the current remote
  service catalog, remote RPC projections, and a ByteStream factory
- **use cases**: read addresses, connection state, and remote services; connect;
  refresh remote services; observe connection changes; access RPC services;
  open byte streams
- **behavior**: explicit dial targets and Identify results supply retained
  addresses; inbound transport source addresses do not. RPC values may contain
  JSON-compatible data and bytes. ByteStream provides asynchronous reads,
  backpressured writes, half-close, and abort without exposing libp2p streams.
  RPC and known protocol access reject services absent from the current remote
  catalog.

#### Registry

- **dependencies**: an owning Peer and its current published service instances
- **structure**: one peer-bound RPC service instance when published
- **use cases**: list services available to the requesting Peer
- **behavior**: each response lists the current instances published to that
  Peer; Registry uses the same per-Peer publication configuration as every
  other service and is enabled by default

#### Discovery

- **dependencies**: an owning Common Network
- **structure**: one optional Network Service Factory which creates a peer-bound RPC
  list and peer-update ByteStream handler, currently hosted by Beacon
- **use cases**: list and observe other connected Peers with advertised
  addresses
- **behavior**: the list initializes consumers; later connection, address, and
  disconnection changes are sent as keyed set or remove updates. A requester is
  excluded from its own list and update stream.

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
- **use cases**: access Signals, Storage, Options, and Vessel Network; close the
  authenticated Session
- **behavior**: construction creates Storage, account Options, then Network.
  Network construction includes its fixed service factories but performs no
  external connection. Failure closes created dependencies. Component access is
  synchronous afterward. Closing Session closes Network, Storage, and Account
  access; consumers then discard the Session and its components.

#### Signals

- **dependencies**: its owning Session
- **structure**: typed Channels keyed by owner and local name
- **use cases**: obtain a Channel; publish; subscribe; unsubscribe
- **behavior**: publication is synchronous, ordered, non-retained, and
  non-replaying. A subscriber failure is logged without event data and does not
  affect the publisher or later subscribers. Platform events, request/response
  flows, Common Network observers, and local reactivity remain outside Signals.

#### Options

- **dependencies**: account-level persistent Storage and Session Signals
- **structure**: category and object accessors plus one change Channel
- **use cases**: traverse category and object scopes; get, set, unset, and
  observe properties
- **behavior**: construction loads scalar values and removes persisted
  non-scalars. Mutations persist before updating the projection and publishing;
  failure changes neither. Concurrent mutations have no ordering contract.
  Values are strings, numbers, booleans, or `null`; `undefined` means absent.
  The TypeScript schema does not validate exact persisted scalar types. Dynamic
  object identifiers are percent-encoded. A missing or true
  `peers/${peerId}/services/${serviceName}.enabled` permits that hosted service;
  false denies it. Observation is synchronous, ordered, non-retained, and
  property-specific.

#### Storage

- **dependencies**: an account username and available browser IndexedDB, OPFS,
  Storage quota estimates, and Web Locks
- **structure**: one volatile root and one persistent root; the volatile root
  contains event, singleton, key/value, and shared file stores; the persistent
  root contains account- and peer-scoped IndexedDB key/value stores
- **use cases**: select retention; access account- or peer-level service stores,
  then kind- and name-scoped stores; read and mutate values; create files; close
  Storage
- **behavior**: construction opens both roots. Volatile data lasts for the
  Session; unencrypted persistent values survive it. Persistent entry lists are
  immutable and key-ordered. File stores share quota accounting and one
  Web-Lock-protected Session OPFS directory; writers declare exact sizes and
  expose completed Blobs while reserving ten percent of quota. Close finishes
  or aborts accepted work before releasing resources. Storage publishes no
  mutations itself.

#### Network

- **dependencies**: the Session identity and account name, Options, Signals,
  browser networking, and the Common Network factory
- **structure**: one Common Network; fixed Identity, Messaging, and DataTransfer
  factories; Network update, Messaging, and DataTransfer Channels
- **use cases**: read local peer ID and supported services; connect directly;
  list connected Peers; observe keyed Peer updates; access Messaging and
  DataTransfer actions; close Network
- **behavior**: construction creates the Common Network and supplies its fixed
  factories. It performs no external connection. For each Common Peer,
  Network reads that peer's service Options centrally and observes those exact
  properties while connected. Changes publish or remove the corresponding
  instance. Common connection, address, service-catalog, and disconnection
  events become one-Peer set or remove updates through Signals.

##### Identity

- **dependencies**: the Session account name and Vessel Network
- **structure**: one Network Service Factory, peer-bound RPC instances, and one remote
  response validator
- **use cases**: return local `{ name }`; request and validate remote Identity
- **behavior**: Identity retains no remote data; Roster owns valid observations.
  Network decides whether to create its RPC instance for each Peer.

##### Messaging

- **dependencies**: Vessel Network and Signals
- **structure**: one Network Service Factory which creates peer-bound RPC instances,
  plus one peer-tagged event Channel
- **use cases**: send text; observe sent, received, and failed messages
- **behavior**: messages require valid opaque IDs and text; Messaging retains no
  Chat state. Network decides whether to create its RPC instance for each Peer.

##### DataTransfer

- **dependencies**: Vessel Network and Signals
- **structure**: one Network Service Factory which creates a peer-bound byte-stream
  handler, plus one ordered event Channel
- **use cases**: offer and send declared-length data; accept with a sink; observe
  progress, completion, and failure
- **behavior**: metadata and length are validated before bytes. A receiver must
  claim an offer during synchronous publication. Transfers preserve
  backpressure, require final acknowledgement, and allow two streams per
  direction per Peer. Progress is limited to one event per 250 milliseconds plus
  the final state. Network decides whether to create its handler for each Peer.
  Interrupted transfers do not resume.

Vessel frontend
---------------

### Application

- **dependencies**: Account and, after authentication, an active Session
- **structure**: Roster and Chat services plus one active Account, Home, or Chat
  view
- **use cases**: authenticate; sign out; navigate between account, peer list,
  and conversation views
- **behavior**: after authentication, Application constructs Chat and then
  Roster before exposing Home. Both subscribe before Home starts an external
  connection. Initialization failure closes the Session.

### Roster

- **dependencies**: Session Vessel Network, persistent Storage, and Signals
- **structure**: one persistent Identity store, one current peer projection,
  and a keyed update Channel
- **use cases**: list or get current peers; refresh remote observations; observe
  one-peer set and remove updates
- **behavior**: construction combines connected, discovered, and remembered
  Peers. Network and Discovery changes update only the affected projection and
  publish that patch. A connection patch makes Roster ask the Peer to refresh
  its service catalog; that catalog controls whether Identity and Discovery are
  queried.
  Provider failures are isolated. Valid Identity is persisted before its peer
  update. Display name falls back from cached Identity name to peer ID.
  Addresses, availability, discovery, and service catalogs remain transient.

### Chat

- **dependencies**: Session Storage, Vessel Network, and Signals
- **structure**: peer-scoped item/order/read/file stores and update and read
  Channels
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
- **structure**: one peer-list signal, peer rows, direct-connection controls,
  and view-local action and Beacon errors
- **use cases**: refresh peers; connect a listed or direct Peer; open Chat; sign
  out
- **behavior**: after subscriptions exist, Home starts the default Beacon
  connection in the background. Refresh retries that connection and refreshes
  Roster. Listed and direct connections call Network directly. Roster patches
  replace or remove one keyed row; Peer catalogs provide Chat capabilities;
  Chat updates maintain unread presentation.

### Chat view

- **dependencies**: Roster and Chat
- **structure**: one Roster-entry signal, Chat-history projection, text and file
  controls, and file downloads
- **use cases**: return Home; read a conversation; send text or files; download
  received files
- **behavior**: the view initializes from Roster and Chat snapshots, applies
  updates for its peer, derives capabilities from its current Peer catalog, and
  marks existing and new received items read. It retains only interaction errors
  and subscription cleanup; Roster owns name and availability while Chat owns
  conversation data.

Beacon
------

### Network

- **dependencies**: configured public relay information, a process identity,
  and Common Network factory
- **structure**: one Common Network with fixed Discovery and Registry factories,
  Identify, and Circuit Relay
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
