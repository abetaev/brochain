development backlog
===================


This document contains:
 - [tasks](#tasks) - requirements to be implemented
 - [thoughts](#thoughts) - drafts of tasks and ideas for future development

Implemented behavior is described in [README.md](./README.md) and [ARCHITECTURE.md](./ARCHITECTURE.md).

tasks
=====

prod deployment
---------------

type: infrastructure
scope: project commands, deployment

The project builds and serves itself and has never been deployed. Give it one command
which validates, builds and ships the application to the server which hosts it, and
document the server it ships to.

- `npm run deploy` MUST validate and build as `npm run prod` does, run the test suite,
  and then place a release on the server, install its dependencies there, make it the
  current one, restart the service and confirm the deployment answers.
- A deploy MUST NOT require privilege on the server. Preparing the server does, and is
  performed once by the engineer.
- The relay identity MUST live outside a release, so a deploy never replaces the peer
  every roster entry, name and service decision refers to.
- The previous release MUST remain, so a rollback is relinking it.
- A reverse proxy terminates TLS, serves the built application and hands Beacon the
  WebSocket upgrades, which is what `VESSEL_HOSTING=off` already leaves it doing.

Configuration a deployment needs which is not the server's own belongs to the developer
machine and is read from `.env`.

screen scroll on android/chrome pwa
-----------------------------------

type: bug
scope: ui

when i reopen installed pwa app on my phone sometimes it makes layout higher than display provoking scrolling
top bar or bottom bar go offscreen. this is not always happening and seems to happen only after app has been in background for some time, maybe when it was offloaded/stopped -- i.e. when it goes back to account selection.

also same issue reproduces when i just refresh pwa by pulling it down.

maybe add some handler which checks this issue and fixes it. worth checking existing bugs, maybe there's less invasive workaround.

invitation service
------------------

type: feature
scope: network service, frontend service, feed entry, invitation view


new feature to send invitation from peer to peer enabled by default in connection profile.
invitation contains list of services that one peer asks another peer to provide.
making an invitation automatically enables listed set of services for target peer when peer accepts invitation and exposes those service from their side.
invitation can be sent multiple times to adjust set of services that peers expose to each other.
sending invitation with reduced set of services may be handled automatically 

invitation notifications should appear in status bar.

invitation should be network and frontend service. if network service is disabled peer will not receive invitations.

identity change notification
----------------------------

type: feature
scope: network services

the identity service is request/response only, so a display name change reaches a peer no
earlier than its next connection. give it an events facet that tells already-connected peers
when the local name changes, following how registry announces its catalog.

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

advanced profiles
-----------------

type: feature
scope: frontend

besides just name profile should contain colors and picture.
picture should be of square size between 256x256 and 1024x1024 pixels

also profiles may contain information about desired color how peer appears in chat


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

workflow Beacon process
-----------------------

type: infrastructure
scope: tests, coverage

`beacon/main.ts` already runs a Beacon of its own, and `VESSEL_HOSTING=off` leaves
one which only relays. Workflows use none of it: both their servers are Vite, so
the Beacon they exercise is the one the Vite plugin creates. Vite bundles its
configuration, so `beacon/core.ts` and the whole of `common/backend/network` reach
that bundle as scripts carrying no attributable file names. Nothing measures what
Beacon exercises, and no workflow can stop or start one.

Give the workflows a Beacon of their own:

- The alternative Beacon in `workflows/beacon.test.ts` becomes `beacon/main.ts`
  with `VESSEL_HOSTING=off`, rather than the Vessel host which also relays, so a
  workflow meets the Beacon a deployment would run. Workflows then start three
  servers: a Vessel host with a Beacon, one without, and the Beacon process.
- A workflow MAY then stop and restart it, which reconnection behaviour needs.
- Collect its coverage through `NODE_V8_COVERAGE` and merge it into the workflow
  report. Node strips types in place, so recorded lines already match the source
  and no source map is required.

The Vite plugin stays either way, because `npm run dev` serves Vessel and its
Beacon from one origin. Only the Beacon the workflows measure changes.

account service coverage
------------------------

type: infrastructure
scope: tests, project commands

Account runs its service in a Worker, and Playwright collects coverage only for a
page: a Worker cannot be reached through `newCDPSession`, and a CDP session
carries no target to route a profiler to. Every workflow creates, unlocks and
exports an account, yet the account service and the halves of `base64` it alone
uses read as unreached.

`page.workers()` does return the Worker and evaluating inside it works, so
instrument the sources instead and read the accumulated counters from the page
and from each Worker. Reporting then covers both, and the mapping which rebuilds
file names from the development server's paths is no longer needed because
instrumented sources carry their own.

This measures what the workflows already exercise; it adds no safety, so it
ranks below work which does.

keyed catalog announcements and event feed recovery
---------------------------------------------------

type: optimization
scope: Common Network, Registry, Peer, events transport

Registry announces its whole published catalog when one service changes, so a
peer reloads a list to learn one name. `reactivity` reserves a snapshot for
initialization and explicit recovery, and the producing side already holds the
keyed change: `Network.publish` knows the service and whether it was published.

- Registry MUST announce one service and its publication rather than the catalog.
- Peer applies that keyed change to its remote catalog instead of replacing it.
- `list` remains the snapshot, used to initialize a catalog and to recover one.

A keyed change is only safe while a lost announcement can be recovered, and today
it cannot be. A remote event feed which fails during a connection is closed
silently and restarted only when a subscriber appears or the catalog changes,
which is the very announcement that would no longer arrive; one dropped stream
leaves the feed dead until the peer reconnects. Define and implement the recovery
protocol before the announcement becomes keyed: a feed which fails while it still
has subscribers and its peer remains connected MUST be re-established, and a
consumer whose feed was interrupted MUST recover the state it may have missed.

call address discovery
----------------------

type: feature
scope: calls, network, options

Call holds a fixed pair of public address discovery servers, which reach beyond one
network but place every caller's address and the timing of every call with someone
else. Replace them with servers this deployment decides on, so a reader chooses whom
their call is disclosed to. Refine where those servers are configured, whether Beacon
advertises its own, and what a reader is told when discovery fails, before
implementation.

 - beacon should implement STUN server with kill-switch that allows to turn it off
 - in global settings view there should be a list of stun servers that are used to traverse NAT

call relay
----------

type: feature
scope: calls, beacon, network
state: draft/needs refinement

Symmetric address translation defeats address discovery, and such a call can
only be carried by a relay. Decide whether Beacon relays call media as it
already relays connection establishment, and refine credentials, capacity, and
the limits a relay places on call quality before implementation.

beacon becomes turn server if this is implemented.
this should be feature that provides security:
- beacon may need to list peers authorized for TURN
- beacon should have configuration settings (UI?)

thoughts
========

conversation becomes a feed
---------------------------

Rename Chat to Feed and widen what a conversation holds: messages, transfers and
calls are already items of one history, and posts join them. A view then shows a
projection of that history rather than all of it, selected by a filter over item
kinds. Retention becomes persistent, so a conversation survives a reload rather
than lasting only for the Session — every item kind is already scalar data except
a transfer's stored file. Refine what a post is, how a filter is chosen and
remembered, whether a projection is a Feed concern or a view's, and what
persistence means for unread counts before implementation.

rich message content
--------------------

Render message text as rich content rather than one run of characters, most
likely markdown, of which the line breaks a sender typed are the simplest case
and today are lost when the bubble is drawn. The text is stored and transported
intact; it is the rendering that collapses it. Refine which markup is supported,
how untrusted remote text is sanitised, and what it does to bubble layout before
implementation.

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

Refine latency-aware routing before designing multi-peer calls.

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
