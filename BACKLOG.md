development backlog
===================


This document contains:
 - [tasks](#tasks) - requirements to be implemented
 - [thoughts](#thoughts) - drafts of tasks and ideas for future development

Implemented behavior is described in [README.md](./README.md) and [ARCHITECTURE.md](./ARCHITECTURE.md).

tasks
=====

restore peer-bound Network Services
-----------------------------------

type: architecture correction
scope: Common Network, Vessel Network, Network Services, Peer, frontend services

Replace the incorrect split between hidden hosted handlers, generic Peer
projections, and Network-wide Messaging/DataTransfer facades.

- Network owns only the fixed catalog of `NetworkServiceFactory` functions.
- On connection, Network reads that peer's Options and passes each enabled
  factory to Peer.
- Peer invokes `(peer) => NetworkService`, owns the returned concrete service,
  and exposes that service to Frontend and Signals.
- A factory creates the complete peer-bound service object; no separate global
  service facade, factory property, second service-construction API, or generic
  remote projection standing in for that object exists.
- Registry follows the same factory and Peer ownership mechanism as every other
  Network Service.
- Identity, Messaging, DataTransfer, Discovery, and Registry each implement the
  same construction and ownership flow while declaring only their applicable
  `remote`, `events`, and `stream` interactions.
- Common Network owns transport routing and does not expose `ByteStream`,
  protocol metadata, or transport-specific service APIs.
- Remove `Network.messaging()` and `Network.dataTransfer()`; Chat and Roster use
  the concrete services exposed by Peer and receive changes through Signals.
- Replace the incorrect implementation documentation and tests only after the
  ownership flow above is implemented.

runtime service catalog updates
-------------------------------

type: functional correction
scope: Common Network, Registry, Peer

Publishing or removing a service for a connected Peer currently changes only the
local published set. The remote Peer keeps the catalog it last read and cannot
observe the change until it refreshes for an unrelated reason.

Registry MUST declare an event interaction which reports its published catalog
to a Peer whenever that Peer's published set changes. A Peer receiving the event
replaces its remote service catalog and publishes the resulting change like any
other catalog refresh.

Per-peer service Options cannot be edited while connected until the settings
frontend and peer view exists, so this correction MUST land no later than that
task and is not reachable before it.

settings frontend and peer view
-------------------------------

type: feature
scope: frontend services, views, components, options, network

Add a `Peer` view which displays information about an identified peer and
provides the generic settings controls used to configure it. Every Home roster
row and Chat MUST provide navigation to this view, and leaving it returns to the
originating view.

Initially, Peer lists the locally supported services from Network's Services
catalog and edits their per-peer enabled Options. Saved changes apply
immediately, including while connected.

peer display-name customization
-------------------------------

type: feature
scope: frontend services, views, roster, options

Extend Peer with editing for `peers/${peerId}.display_name`. A display name is
arbitrary Unicode text which is trimmed before storage and MUST contain 1–64
characters. The saved display name is the source of truth for every UI reference
to that peer in Home, Chat, and Peer, with cached identity name and peer ID as
fallbacks.

The cached remote Identity remains available in Peer for reference and MUST NOT
be overwritten by local naming. The option remains absent until the user saves
a display name; it MUST NOT be initialized from Identity. A saved-name change
publishes the peer's Roster update so current views use the new name.

message confirmations
---------------------

type: feature
scope: network services, messaging, chat, signals, storage, UI

The sender UI uses each Chat item's existing opaque ID to track and show separate
delivered and read states while continuing to render a send immediately.

Delivery requires an explicit remote acknowledgement produced only after the
recipient validates and Chat retains the message. Successful transport, RPC, or
Signals publication alone MUST NOT imply retention because Signals isolates
subscriber failures. When Chat renders a received message, the recipient sends
a separate read confirmation for that message ID. Failed read confirmations
remain queued in transient Session state and retry when the peer reconnects
during that Session; confirmations are not persisted for offline delivery.

secrecy
-------

type: feature
scope: backend core components, account, network, storage

Add the Session-owned `secrecy` core component to provide encryption and
decryption capabilities to other components. It composes Account-held local
secrets with authenticated peers' public keys without exposing private key
material to consumers.

Secrecy owns cryptographic transformation while Storage only retains supplied
ciphertext. A later Storage policy may select encrypted access through
`session.storage(options)`; the initial persistent Storage implementation
remains unencrypted. Refine the key hierarchy, peer public-key access, ciphertext
envelope and versioning, rotation, recovery, and failure behavior before
implementation.

single active account Session
-----------------------------

type: feature
scope: account, session, browser lifecycle

Reject authentication for an account which already has an active Session in
another tab or window of the same browser. Ownership MUST be released after
explicit Session shutdown and execution-context termination. Refine whether a
SharedWorker, Web Locks, or another browser-wide coordination mechanism owns
the lock before implementation.

thoughts
========

portable accounts
-----------------

Allow an exported encrypted account to be imported or transmitted to a
connected peer during a Session, so it becomes a local account on the receiving
browser and can connect with the same network identity. Refine consent,
validation, username collisions, password verification, whether persistent
Storage is included, transport security, and simultaneous use of one identity
before implementation.

beacon connections
------------------

Support an explicitly configured Beacon URL for non-server environments and connections to multiple Beacons. The run-mode default remains sufficient until this task is refined.

beacon evolution
----------------

Evolve Beacon into a feature-rich headless service host through the Common
Network service catalog. Initially retain one process-lifetime volatile account
and identity. Introduce Node-compatible Storage only when a hosted service needs
retention, then reconsider whether a runtime-neutral Session should be shared
with Vessel. Refine persistent identity, administration, service selection,
Options, quotas, security, deployment, and whether multiple accounts are needed
before implementation.

peer discovery
--------------

Host peer discovery on Vessel so connected Vessels can discover peers without Beacon.

roster service history
----------------------

Retain every remote service ever observed and distinguish historical support
from presence in the latest successful online catalog refresh. Offline service
history is informative only; operations still require current online capability
and Options approval.

runtime option schemas
----------------------

Replace Options' type-only schema fragments with code-defined descriptors which
infer the same TypeScript DSL while validating exact persisted scalar types at
runtime. Preserve existing consumer `cat`, `obj`, `get`, `set`, `unset`, and
`observe` syntax; refine descriptor composition and invalid-value handling before
implementation.

calls
-----

- Add direct voice and video calls.
- Refine latency-aware routing before designing multi-peer calls.

browser workflows
-----------------

Add Playwright workflows that demonstrate complete user interactions. `npm run test` MUST run them together with the necessary lower-level tests.

storage
-------

Add two storage services:

- versioned file storage backed by OPFS through an isomorphic-git-compatible filesystem adapter
- queryable metadata storage backed by IndexedDB

opaque remote storage
---------------------

Allow a peer to host another peer's client-encrypted data while the host retains
only opaque ciphertext. Refine authentication, quotas, integrity verification,
availability and replication, deletion, abuse controls, and recovery before
implementation. Hosting may later integrate with the economy through fees and
possibly blockchain-based agreements or settlement.
