development backlog
===================


This document contains:
 - [tasks](#tasks) - requirements to be implemented
 - [thoughts](#thoughts) - drafts of tasks and ideas for future development

Implemented behavior is described in [README.md](./README.md) and [ARCHITECTURE.md](./ARCHITECTURE.md).

tasks
=====

storage modes
-------------

type: feature
scope: backend services

Storage is solely responsible for retaining and retrieving data and should
provide in-memory and persistent implementations. Preserve the existing event,
singleton, and key/value operations, but implement a persistent store kind only
when a current consumer requires it. Options initially requires persistent
key/value storage; persistent event storage is deferred until a durable consumer
such as chat history is introduced.

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

Roster uses persistent Storage to cache the latest valid whole Identity object
for each remote peer at `peers/${peerId}.identity`. Identity currently has the
shape `{ name: string }`.

When a connected peer exposes Identity, Roster refreshes and validates the
cached value. A failure MUST retain the last valid cache. Roster initializes the
editable `peers/${peerId}.display_name` Option from `identity.name` only when the
option is absent; later identity refreshes MUST NOT overwrite it.

When presenting a currently connected or discovered peer, Roster resolves its
name in this order: display-name Option, cached identity name, peer ID. It does
not persist peer availability, addresses, or Discovery results.

network service collection
--------------------------

type: feature
scope: network, services, options

Network owns one introspectable catalog containing every service the local
application can publish:

```ts
type Services = Record<string, Service>
```

This catalog is the single source used for service publication and for settings
introspection. Existing plain service names remain unchanged. Versioned service
identifiers and plugin extensibility are future work.

Registry remains mandatory. Other supported services are enabled by default for
each remote peer and may be disabled with
`peers/${peerId}/services/${serviceName}.enabled`. Each Peer publishes only its
enabled subset to that identified remote peer, and Registry reports that current
subset. Option changes MUST affect an existing connected Peer immediately.

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

Every text or file message has an opaque unique ID. The sender UI tracks and
shows separate delivered and read states for that message while continuing to
render a send immediately.

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
