development backlog
===================


This document contains:
 - [tasks](#tasks) - requirements to be implemented
 - [thoughts](#thoughts) - drafts of tasks and ideas for future development

Implemented behavior is described in [README.md](./README.md) and [ARCHITECTURE.md](./ARCHITECTURE.md).

tasks
=====

migrate event consumers to Signals
----------------------------------

type: refactoring, architecture
scope: network, frontend services, signals

Replace remaining component-owned observer APIs with public Signals channels
where a current cross-component runtime event requires integration. Network,
Peer, and Roster currently expose direct subscription APIs; refine which of
these events and consumers should migrate before implementation.

Common Network is shared with Beacon and MUST NOT depend directly on Vessel's
account-bound Signals. Preserve that boundary through dependency inversion or a
Vessel integration adapter, and keep Signals non-retaining so consumers read a
retained projection when they require current state.

unified Storage
---------------

type: refactoring, architecture
scope: storage, session, chat, data transfer

`data-storage` MUST NOT remain a separate component. Storage is the sole
account-bound retention component and MUST expose every storage capability
required by the application, including streamed opaque binary data.

Move the current declared-length OPFS writer, stored-data handle, quota
reservation, partial-write cleanup, Web Lock coordination, and Session cleanup
behind Storage's public interface. Streamed values are addressed through the
same peer and service ownership hierarchy as other retained values; filesystem
names remain private implementation details. Chat and DataTransfer access them
through `session.storage()`.

Storage owns retention and lifecycle, Chat owns file presentation metadata,
DataTransfer owns transport and byte flow, and Signals retains nothing. The
binary interface MUST preserve streaming and backpressure without buffering a
complete value in application memory. Existing event, singleton, and key/value
behavior remains available. Future retained representations extend Storage
rather than introduce sibling storage components.

Remove `Session.dataStorage()`, `DataStorage`, `createDataStorage()`, and
`vessel/backend/data-storage.ts` after all consumers migrate. Session shutdown
closes its one Storage component and cleans up incomplete transient data.

storage modes
-------------

type: feature
scope: backend services

Extend the unified Storage component with in-memory and persistent modes.
Preserve its structured and streamed-data capabilities, but implement a
persistent store kind only when a current consumer requires it. Options
initially requires persistent key/value storage; persistent event storage is
deferred until a durable consumer such as chat history is introduced.

Persistent operations are asynchronous and MUST make failures observable.
Persistent data is isolated by the unlocked local account identity and MUST be
deleted when that account is deleted. In-memory data remains limited to its
owning Session.

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
scope: network services, messaging, signals, storage, UI

The sender UI uses each Chat item's existing opaque ID to track and show separate
delivered and read states while continuing to render a send immediately.

Successful completion of the remote send operation marks the message delivered
because the recipient has validated and retained it. When Chat renders a
received message, the recipient sends a separate read confirmation for that
message ID. Failed read confirmations remain queued in transient Session state
and retry when the peer reconnects during that Session; confirmations are not
persisted for offline delivery.

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

- versioned file storage backed by ZenFS and isomorphic-git
- queryable metadata storage backed by IndexedDB
