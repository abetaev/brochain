development backlog
===================


This document contains:
 - [tasks](#tasks) - requirements to be implemented
 - [thoughts](#thoughts) - drafts of tasks and ideas for future development

Implemented behavior is described in [README.md](./README.md) and [ARCHITECTURE.md](./ARCHITECTURE.md).

tasks
=====

options
-------

type: feature
scope: backend services

The `options` core component uses persistent key/value Storage for editable
settings. “Settings” designates the frontend which edits Options; it is not the
backend component name. Observed remote data, such as cached identity, MUST
remain owned by the service that observed it rather than Options.

Option keys follow this documented convention:

- terms use `[A-Za-z0-9_-]+` and designate entities
- dots designate object properties, including nested properties
- slashes designate collections and their members; a collection may contain
  another collection but MUST NOT be nested inside an object property
- a collection member may have properties

The convention is descriptive and MUST NOT be enforced by Options.

persistent roster
-----------------

type: feature
scope: frontend services, roster, storage, options

Roster exposes one unified collection containing connected, discovered, and
cached-only peers. Each entry includes the peer ID, an optional current Peer,
current online state, the latest cached Identity, and its resolved presentation
name. Roster uses persistent Storage to cache the latest valid whole Identity
object for each remote peer at `peers/${peerId}.identity`. Identity currently has
the shape `{ name: string }`.

When a connected peer exposes Identity, Roster refreshes and validates the
cached value. A failure MUST retain the last valid cache. Roster initializes the
editable `peers/${peerId}.display_name` Option from `identity.name` only when the
option is absent; later identity refreshes MUST NOT overwrite it.

Roster resolves every entry's name in this order: display-name Option, cached
identity name, peer ID. It does not persist peer availability, addresses, or
Discovery results; a cached-only peer therefore cannot reconnect until it is
discovered again.

Persisted hosted-service observations are deferred. When introduced, Roster
retains every service name ever observed and records whether it was present in
the latest successful online catalog refresh. An offline entry exposes that
status explicitly as historical information. Chat and other operations MUST
still require current online capability and Options approval.

per-peer service options
------------------------

type: feature
scope: network, services, options

Use Network's existing service-facet catalog as the single source for service
publication and settings introspection; this task MUST NOT introduce another
registry. Registry remains mandatory. Other supported services are enabled by
default for each remote peer and may be disabled with
`peers/${peerId}/services/${serviceName}.enabled`. Each Peer publishes only its
enabled subset to that identified remote peer, and Registry reports that current
subset. Option changes MUST affect RPC and byte-stream facets for an existing
connected Peer immediately.

Existing plain service names remain unchanged. Versioned service identifiers
and plugin extensibility are future work.

settings frontend and peer view
-------------------------------

type: feature
scope: frontend services, views, components, options, network

Add a `Peer` view which displays information about an identified peer and
provides the generic settings controls used to configure it. Every Home roster
row and Chat MUST provide navigation to this view, and leaving it returns to the
originating view.

Initially, Peer lists the locally supported optional services from Network's
Services catalog and edits their per-peer enabled Options. Registry is not
configurable. Saved changes apply immediately, including while connected.

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
be overwritten by local naming.

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

beacon connections
------------------

Support an explicitly configured Beacon URL for non-server environments and connections to multiple Beacons. The run-mode default remains sufficient until this task is refined.

peer discovery
--------------

Host peer discovery on Vessel so connected Vessels can discover peers without Beacon.

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
