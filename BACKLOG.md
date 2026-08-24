development backlog
===================


This document contains:
 - [tasks](#tasks) - requirements to be implemented
 - [thoughts](#thoughts) - drafts of tasks and ideas for future development

Implemented behavior is described in [README.md](./README.md) and [ARCHITECTURE.md](./ARCHITECTURE.md).

tasks
=====

options path DSL
----------------

type: refactor
scope: options and its consumers

Replace raw Option keys and consumer-owned string construction/parsing with a
hierarchical Options DSL. The initial direction is an alternating category and
object path whose final property is read or mutated directly:

```ts
const peer = options.cat("peers").obj(peerId);

peer.get("display_name");
await peer.set("display_name", name);
await peer.unset("display_name");

const service = peer.cat("services").obj(serviceName);
await service.set("enabled", false);
```

The examples resolve internally to `peers/${peerId}.display_name` and
`peers/${peerId}/services/${serviceName}.enabled`. Consumers MUST express the
semantic hierarchy through the DSL and MUST NOT know, assemble, or parse this
serialized notation. This should remove option-path constants and helpers from
Roster and prevent the upcoming service settings work from spreading opaque
keys.

Scoped change observation should likewise expose category, object, property,
and value semantics without requiring subscribers to parse a raw key. Preserve
Options' scalar values, synchronous reads, serialized persistence-first writes,
no-op suppression, and notification-after-projection behavior.

Before implementation, refine:

- the exact scope and change-channel interfaces, including observation of all
  objects in a category versus one selected object;
- whether `cat` and `obj` scopes are stable entities or lightweight views over
  one Options projection;
- segment validation or escaping so `/` and `.` cannot make paths ambiguous;
- whether the raw root `get`, `set`, `unset`, and change API is removed entirely;
- the minimum recursive grammar needed for peer service options without making
  arbitrary configuration trees part of the public contract.

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
