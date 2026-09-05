architecture
============

The implemented technical architecture. Architectural direction and diagram
semantics are in [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

brochain is the browser application **Vessel**, the reusable **Common** backend,
and the headless bootstrap and relay peer **Beacon**.

structure
---------

```text
Common
├── Signals
└── Network
    ├── Peer × remote identity
    │   └── published Network Service instances
    ├── fixed Network Service Factory catalog
    └── RPC, event, and data transports

Vessel
├── Backend
│   ├── Account
│   │   ├── Window facade
│   │   └── Worker account service
│   └── Session
│       ├── Options
│       ├── Storage
│       │   ├── volatile root
│       │   └── persistent root
│       └── Network
│           ├── Common Network
│           └── Identity, Messaging, DataTransfer, and Calling factories
└── Frontend
    ├── Roster
    ├── Chat
    ├── Call
    └── Account, Home, Chat, Peer, and Call views

Beacon
└── Common Network
    ├── Discovery factory
    └── Circuit Relay
```

Backend and frontend are dependency layers, not deployments; both Vessel layers
run in the browser and Account operations run in a Worker. Signals belongs to no
component. Vessel and Beacon share one Common Network implementation.

Common
------

### Signals

- **dependencies**: none
- **structure**: the application event bus; a factory of independent Channels
- **use cases**: obtain a typed Channel
- **behavior**: publication is synchronous, ordered, non-retained, and
  non-replaying; a subscriber failure affects neither the publisher nor later
  subscribers. A Channel's owner publishes, and consumers receive a Subscription
  which only subscribes.

### Network

- **dependencies**: valid libp2p configuration, a fixed Network Service Factory
  catalog, and a per-Peer publication decision
- **structure**: one libp2p node, Peers, the factory catalog including the
  standard Registry factory, and the RPC, event, and data transports
- **use cases**: read local identity and addresses; create and list Peers;
  inspect supported services; publish or remove one service for a Peer; observe
  Peer updates; close Network
- **behavior**: an identified address creates a disconnected Peer; an
  unidentified address is dialed to resolve its identity, and concurrent attempts
  for one identity converge on one Peer. Intermediary relay connections used to
  establish WebRTC are ignored; only a completed direct connection creates a
  Peer. Connection creates that Peer's published instances and then publishes
  `connected`; losing the final direct connection publishes `disconnected` and
  removes the Peer. A publication change adds or removes one instance and
  publishes that change. Accepted RPC and data work finishes on its instance,
  while removing an instance closes its event feeds. The catalog is fixed for the
  Network lifetime.

#### Network Service

- **dependencies**: an owning Peer
- **structure**: a factory `(peer) => service` and up to three declared facets —
  `remote` methods, an `events` Channel, and `data`
- **use cases**: answer a peer's calls; publish events to it; exchange bytes
- **behavior**: a host writes plain `remote` methods and publishes to `events`;
  the same contract reaches its peer as promised methods, a Subscription, and a
  Stream. A service declares only the facets it uses, and each instance is bound
  to one Peer.

#### Peer

- **dependencies**: an owning Network and a resolved remote identity
- **structure**: retained addresses, the last remote service catalog, published
  service instances, and one remote projection per service
- **use cases**: read addresses, connection state, remote services, and whether a
  service is published; connect; disconnect; refresh remote services; access a
  service
- **behavior**: connection state derives from the live libp2p connections.
  Explicit dial targets and Identify results supply retained addresses; inbound
  source addresses do not. Accessing a service returns the published instance
  with its methods aimed at the peer, or a pure remote projection when nothing is
  published. Peer never checks whether a peer provides a service: an interaction
  is attempted and the peer's refusal is reported. A catalog change makes closed
  event feeds retry. Disconnection releases the Peer's instances, event feeds,
  and transfers. Transport protocols and libp2p streams stay private to Network.

#### Stream

- **dependencies**: an owning Network Service
- **structure**: tracked transfers, each with an identifier, an optional declared
  size, progress, and completion
- **use cases**: send a byte source; accept the next incoming transfer; abort
- **behavior**: an absent size means the length is not known in advance, as for a
  live capture; progress is the transferred count, and only a declared size makes
  a proportion meaningful. Progress publishes at most every 250 milliseconds plus
  the final count. Two transfers per direction are active at once and further
  sends fail. Transfers preserve backpressure, complete on the receiver's
  acknowledgement, and do not resume.

#### Registry

- **dependencies**: an owning Peer and its published instances
- **structure**: the published catalog and one announcement Channel
- **use cases**: list the services published to the requesting Peer; announce a
  changed catalog to it; observe a peer's announcements
- **behavior**: Registry follows the same per-Peer publication as every other
  service and is enabled by default. Refusing it to a peer leaves that peer no
  way to learn what is supported and so bars it, and the refusal is announced
  before the instance goes. A publication change announces the new catalog to
  that peer, which replaces its remote catalog and publishes the change without
  asking again. Catalog reads remain lazy: a Peer whose Registry cannot be listed
  is terminated when a consumer asks.

#### Discovery

- **dependencies**: an owning Network
- **structure**: one optional factory creating a peer-bound remote list and
  peer-update Channel, currently hosted by Beacon
- **use cases**: list and observe other connected Peers with advertised addresses
- **behavior**: the list initializes consumers; later connection, address, and
  disconnection changes arrive as keyed set or remove updates. A requester is
  excluded from its own list and update stream.

Vessel backend
--------------

### Account

- **dependencies**: browser IndexedDB and Web Crypto, a Worker, and the Session
  factory
- **structure**: a Window facade, Worker account service, and private
  Session-access channel
- **use cases**: list, create, unlock, export, and delete local accounts
- **behavior**: account records contain only versioned encrypted data; passwords,
  decrypted secrets, and the peer identity seed remain in the Worker. Creation
  and unlock create a Session. Deletion password-confirms and removes
  `brochain/<username>` before its account record. Window authentication calls
  execute directly and have no concurrent ordering contract.

### Session

- **dependencies**: an unlocked Account identity and available IndexedDB, OPFS,
  and Web Locks
- **structure**: one instance each of Storage, Options, and Vessel Network
- **use cases**: access Storage, Options, and Network; close the authenticated
  Session
- **behavior**: construction creates Storage, account Options, then Network,
  which performs no external connection; failure closes what was created.
  Component access is synchronous afterwards. Closing closes Network, Storage,
  and Account access; consumers then discard the Session and its components.

#### Options

- **dependencies**: account-level persistent Storage and Signals
- **structure**: category and object accessors plus one change Channel
- **use cases**: traverse category and object scopes; get, set, unset, and
  observe properties
- **behavior**: construction loads scalar values and removes persisted
  non-scalars. Mutations persist before updating the projection and publishing;
  failure changes neither. Concurrent mutations have no ordering contract. Values
  are strings, numbers, booleans, or `null`; `undefined` means absent. The
  TypeScript schema does not validate exact persisted scalar types. Dynamic
  object identifiers are percent-encoded. `peers/${peerId}/services/${serviceName}.enabled`
  publishes or withholds that service for that peer, and absent means the peer
  decides nothing and follows this peer's own values, the connection profile, whose
  own absent value grants Registry alone. `peers/${peerId}.display_name` names that
  peer wherever it is shown. This peer is one of them, configured under its own peer
  ID and read the same way, so asking about it asks the profile: its `display_name`
  overrides the account username. Observation is synchronous, ordered,
  non-retained, and property-specific.

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
  expose completed Blobs while reserving ten percent of quota. Close finishes or
  aborts accepted work before releasing resources. Storage publishes no mutations
  itself.

#### Network

- **dependencies**: the Session identity and account name, Options, browser
  networking, and Common Network
- **structure**: one Common Network supplied with the fixed Identity, Messaging,
  DataTransfer, and Calling factories
- **use cases**: everything Common Network provides, plus connect by address
- **behavior**: Vessel adds one thing to the Common Network — the account's
  Options decide which services each peer may reach. A peer's own values answer
  first and the connection profile answers for every peer which holds none, so one
  rule covers a peer which reached us and a peer we reached alike; reaching out
  decides nothing. Both are observed while a peer stays connected, and a profile
  change re-decides every peer following it, so either publishes or removes that
  instance immediately. Withholding Registry bars a peer entirely, which the
  emptied catalog announces before its connection is closed; the withheld value
  persists, so that peer is closed again whenever it returns. The gate is at the
  application layer, so a barred connection completes before it is closed.

##### Identity

- **dependencies**: the Session account name
- **use cases**: return the local `{ name }`; read and validate a peer's Identity
- **behavior**: Identity retains no remote data; Roster owns valid observations.

##### Messaging

- **dependencies**: Signals
- **structure**: `remote.send` and an `events` Channel of received text
- **use cases**: send text to a peer; observe text received from it
- **behavior**: arriving text is validated and published. Messaging retains no
  Chat state and no message identity; delivery is the resolution of the remote
  call.

##### DataTransfer

- **dependencies**: Signals
- **structure**: `remote.offer`, an `events` Channel, `data`, and a local send
  action available while the service is published
- **use cases**: offer and send data; accept an offer with a sink; observe
  progress, completion, and failure
- **behavior**: metadata is validated before its offer is published, and a
  receiver MUST claim that offer during the synchronous publication. Accepted
  content travels on the Stream, which owns identity, size, progress, and
  completion. Content which was never offered is refused.

##### Calling

- **dependencies**: Signals
- **structure**: `remote.invite`, `remote.accept`, `remote.candidate`,
  `remote.end`, and an `events` Channel of those signals
- **use cases**: invite a peer to a call, accept one, offer an address candidate,
  and report an ending
- **behavior**: media cannot travel over the connection a peer already has,
  because the WebRTC transport owns that peer connection, exposes no way to
  renegotiate it, and carries data channels alone. Calling therefore carries what
  a second peer connection needs, and holds no call state itself. Each signal is
  validated before publication, and an ending is one of a closed set so the words
  a reader sees are never a peer's.

Vessel frontend
---------------

### Application

- **dependencies**: Account and, after authentication, an active Session
- **structure**: Roster, Chat, Call, and Notifications services plus one active
  Account, Home, Settings, Chat, Peer, or Call view
- **use cases**: authenticate; sign out; navigate between account, peer list, and
  conversation views
- **behavior**: after authentication, Application constructs Call, Chat, and then
  Roster before exposing Home, so each subscribes before Home starts an external
  connection. Initialization failure closes the Session. Application owns
  navigation, so it is what gives each Notification somewhere to go, deciding where
  selecting one leads: a running call to the Call view,
  anything else — a call still ringing included, since that is answered in the
  conversation — to the conversation. The call being watched is not offered back to
  itself. The Call view exists only while a call runs: Application opens it when one
  is answered and returns to the conversation the moment it is over.

### Roster

- **dependencies**: Session Network, persistent Storage, and Signals
- **structure**: one persistent Identity store, the observed display-name Options,
  one current peer projection, and a keyed update Channel
- **use cases**: list or get current peers; refresh remote observations; reset a
  peer's name; read or forget a peer's reported name; observe one-peer set and
  remove updates
- **behavior**: construction combines connected, discovered, and remembered
  Peers. Network and Discovery changes update only the affected projection and
  publish that patch. A connection update makes Roster refresh that Peer's
  catalog, and the catalog decides whether Identity and Discovery are queried.
  Provider failures are isolated. Valid Identity is persisted before its peer
  update, and names the peer the first time one is read, because a name is seeded
  only while none is held; a chosen name therefore survives every later
  identification. A peer with no name is shown by its peer ID. Resetting concerns
  the name alone: it returns to whatever the peer last reported. The reported
  Identity is read again while the peer publishes one and is forgotten otherwise,
  so a peer becomes its peer ID only once that report is dropped and the name
  reset. Addresses, availability, discovery, and service catalogs remain
  transient.

### Settings

- **dependencies**: Session Network, Options, and the account username
- **structure**: the local peer ID and its observed display-name Option
- **use cases**: read this peer's ID and name; observe name changes
- **behavior**: Roster holds remote peers only, so this peer is read straight from
  the Options it is named in, under its own peer ID like any other peer. The
  account username names it until a name of its own is chosen, and every view
  showing this peer reads the same one.

### Notifications

- **dependencies**: Roster, Chat, Call, and Signals
- **structure**: one gathered notification list and a Channel publishing it
- **use cases**: list what is waiting for a reader; observe changes to it
- **behavior**: a notification exists for a peer holding unread items or a call
  which has not ended — waiting to be answered, or already running, which is how a call
  a reader navigated away from stays reachable. A call from a peer the Roster does
  not hold is still raised. Notifications are gathered once for the whole
  application rather than by each view, and republished only when the list actually
  differs, so unrelated Chat and Roster traffic does not redraw the bar. What
  opening one leads to is not theirs to say; Application attaches that, because it
  owns navigation.

### Chat

- **dependencies**: Session Storage, Network, Call, and Signals
- **structure**: peer-scoped item, order, read, and file stores, item and read
  Channels, and subscriptions to each Peer's published Messaging and DataTransfer
  and to the current Call
- **use cases**: inspect history, unread count, and capabilities; mark read; send
  text or files; record a call; observe item and read updates
- **behavior**: Chat owns conversation identity — it assigns every item's
  identifier and derives sent and failed state from its own remote call. It
  subscribes to the instances a Peer publishes, which exist before that peer's
  catalog is known, while the catalog gates the text and file controls. A file
  also needs the instance this peer publishes, because the sender's own instance
  tracks the transfer, so a peer nothing is published to cannot be sent one. Incoming
  files stream into Chat's file store and an offer without a declared size is
  refused. A call is the third thing that happens with a peer and is written into
  the same conversation as the other two: one item raised when the call begins and
  revised until it is over, holding the call's own states rather than a transfer's.
  Pending is calling, connecting and active are ongoing, and a cleared call ends
  like an ended one, because a reader's own hang-up and a decline clear a call
  rather than end it; revisions the conversation does not show — a stream arriving,
  a track muted — write nothing. Its identifier is minted per call, so a second
  call to a peer is a second item. A call takes its place in the conversation's
  order and an incoming one counts toward what is unread. Conversation state
  survives view navigation and lasts for the Session.

### Call

- **dependencies**: Network, Signals, browser media capture, and browser peer
  connections
- **structure**: one current call, its peer connection and captured media, and a
  Channel publishing the call
- **use cases**: report whether a peer can be called; place, accept, decline, and
  end a call; mute the microphone and stop the camera
- **behavior**: Call owns one call at a time and keeps it for the Session, so
  navigation cannot end it. Capture begins only once a reader accepts, and a
  second invitation arriving during a call is refused as busy. No address server
  is configured, so a call reaches only a local network. Candidates arriving
  before their description exists are held and applied with it. Muting and
  stopping the camera disable tracks rather than renegotiate. A reader's own hang
  up simply clears the call; what the far side or a failing media path did is
  reported with the ending, and the conversation's record is what keeps it.

### Account view

- **dependencies**: Account
- **structure**: account forms, PasswordStrength, export controls, and deletion
  controls
- **use cases**: create, unlock, export, and delete accounts
- **behavior**: one busy state prevents concurrent mutations; successful
  authentication hands the Session to Application.

### Peer view

- **dependencies**: Session, Roster, Call, and the peer identity being configured
- **structure**: one Roster-entry signal, the published-service projections
  observed from Options, and view-local settings errors; the peer's name belongs
  to the identity block, which owns naming for whichever peer it shows
- **use cases**: read a peer's identity, availability, and addresses; name it,
  reset its name, refresh or forget its reported name; publish or refuse each
  supported service for it, or return it to the profile; open its conversation, or
  place a call into it
- **behavior**: the view lists the locally supported services and reflects each
  peer's Options while open, so a change made elsewhere appears. A name is trimmed
  and must be 1 to 64 characters; the reported Identity stays shown beside it and
  is never replaced by local naming. One control serves that report, offering to
  refresh it while the peer publishes Identity and to forget it otherwise. Each
  service says whether it follows the profile or decides for itself, and a connected
  peer holding nothing but Registry reads as requesting a connection rather than
  merely connected, because what is published to a peer is what it reaches. A
  refusal takes effect immediately, including while connected. A refused write restores its
  control and reports the failure. Placing a call opens that peer's conversation,
  which is where the call's record and its controls live. Leaving returns to the
  view which opened it.

### Settings view

- **dependencies**: Session
- **structure**: view-local settings errors; this peer's name belongs to the
  identity block and its services to the same list, both the ones the Peer view uses
- **use cases**: read this peer's ID and addresses; name it and reset that name;
  decide what a peer nobody has decided about reaches
- **behavior**: Options keys this peer the way it keys any other, so the view is
  the Peer view turned on ourselves and hands the same identity block the same
  `display_name`, differing only in what names us while none is chosen — the
  account username, which resetting returns to — and in its services being the
  profile every other peer falls back to, which is why they carry no control saying
  where their value came from. This peer's own ID and addresses are shown because they are what
  someone else needs for Home's direct connection and appear nowhere else. A
  refused write restores its control and reports the failure. It is reached by this
  peer's own avatar in Home's status bar, and leaving returns there.

### Home view

- **dependencies**: Session, Roster, and Chat
- **structure**: one peer-list signal, peer rows, direct-connection controls, and
  view-local action and Beacon errors
- **use cases**: refresh peers; connect a listed Peer or a direct address; open
  Chat, Peer, or this peer's own Settings; sign out
- **behavior**: once subscriptions exist, Home starts the default Beacon
  connection in the background, and Refresh retries it and refreshes Roster.
  Selecting a listed Peer connects and opens its conversation, whatever that peer
  turns out to offer, because a peer which has not yet let us in offers nothing and
  is not a peer without a conversation. A connected peer holding nothing but
  Registry is listed as requesting a connection. A direct address
  completes only the connection procedure, so a peer offering no conversation is
  still reached; it accepts a URL or a multiaddress. Roster patches replace or
  remove one keyed row, Peer catalogs provide Chat capabilities, and Chat updates
  maintain unread presentation.

### Call view

- **dependencies**: Session, Roster, and Call

- **structure**: one call signal, one Roster-entry signal, both video elements,
  and the call controls the current call state generates
- **use cases**: watch a running call; mute, stop the camera, and hang up; return
  to the conversation
- **behavior**: streams are attached from an effect, so a reader returning to a
  running call sees it again. The view is only ever open while the call runs, so it
  offers nothing for answering or refusing one — that belongs to the conversation —
  and leaving it simply leaves. What the call is doing is captioned over the
  conference, which otherwise fills the view.

### Chat view

- **dependencies**: Roster, Chat, and Call
- **structure**: one Roster-entry signal, Chat-history projection, text and file
  controls, and file downloads
- **use cases**: return Home; open Peer; read a conversation; send text or files;
  download received files; place a call, and answer, refuse, rejoin or end the one
  the conversation holds
- **behavior**: the view initializes from Roster and Chat snapshots, applies
  updates for its peer, derives capabilities from its current Peer catalog, and
  marks existing and new received items read. A call in the conversation carries
  its own controls, which is where a call is answered and refused, so placing one
  leaves the reader here rather than taking them anywhere; a second call is
  withheld while one is in progress. It retains only interaction errors and
  subscription cleanup; Roster owns name and availability while Chat owns
  conversation data.

Beacon
------

### Network

- **dependencies**: the address the server answers on, a process identity, and
  Common Network
- **structure**: one Common Network with the Discovery factory, Identify, and
  Circuit Relay, listening privately on loopback
- **use cases**: accept Vessel bootstrap connections; relay connection
  establishment; advertise connected Peers
- **behavior**: Beacon retains no application messages and keeps one identity for
  its process lifetime. A WebSocket is an HTTP upgrade, so the server hosting
  Vessel hands Beacon the upgrades it does not want and Beacon answers on the one
  address people already trust. Hosting Vessel and providing the relay are
  independent and either may be switched off, so a server can host the
  application for people whose relay is elsewhere, or relay for applications
  hosted elsewhere. Restart creates a new identity.

runtime and technologies
------------------------

- **Common Network**: libp2p and typed-rpc
- **Vessel backend**: browser Worker, Comlink, IndexedDB, OPFS, Web Locks, Web
  Crypto, libp2p WebSockets, Circuit Relay v2, WebRTC, Noise, Yamux, and Identify
- **Vessel frontend**: SolidJS, Pico CSS, and a Vite-generated PWA shell
- **Beacon**: Node.js, libp2p WebSockets, Circuit Relay v2, Noise, Yamux,
  Identify, and Identify Push
