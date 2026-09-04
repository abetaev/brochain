development backlog
===================


This document contains:
 - [tasks](#tasks) - requirements to be implemented
 - [thoughts](#thoughts) - drafts of tasks and ideas for future development

Implemented behavior is described in [README.md](./README.md) and [ARCHITECTURE.md](./ARCHITECTURE.md).

tasks
=====

multiline messages render as one line
-------------------------------------

type: bug
scope: chat, UI

a message typed across several lines arrives and renders as a single run of text — the
line breaks the sender put in are lost when the bubble is drawn. the text is stored and
transported intact; it is the rendering that collapses it.

handheld view layout
--------------------

type: usability
scope: frontend views

move home, chat and peer onto the Handheld layout the account views already use, so every
view gets its StatusBar, bottom-aligned content and generated ActionBar from one place.
content on all three currently sits at the top of the main area instead of within finger
reach at the bottom.

chat's message avatars should attach to their message the way the mockup draws them: the
40px avatar tag butts flush against the bubble with no gap and interlocking corner radii,
top-aligned against a taller bubble — not a detached circle.

peer needs restructuring: avatar, name and info above the service toggles; no explanatory
prose between the services header and the toggles; peer id must not overflow its box (clip
with an ellipsis); addresses are long, so collapse them by default; reset name and refresh
identity belong in one centered row directly under the editable name. auto connect is not a
service and leaves that list entirely.

the cog in home's action bar goes — local settings are reached by tapping the local peer's
avatar in the status bar instead.

local peer options
------------------

type: feature
scope: options, network

settings that describe this peer's own behaviour, keyed the same way remote peers already
are: `peers/{localPeerId}.auto_accept_connections`, and `peers/{localPeerId}.display_name`
reusing the existing peer-names module. the local peer id is `session.network().id`; expose
it to views. follow the shape of `vessel/backend/options/peer-names.ts` — the options engine
needs no change.

connection approval
-------------------

type: feature
scope: network, options, UI

a peer connecting for the first time is not trusted automatically. until it is approved no
services are published to it and it shows as requesting a connection; approving publishes
and remembers the decision, rejecting closes the connection and remembers that too. when
`auto_accept_connections` is set, requests are approved without asking.

the gate is at the application layer for now: the transport connection still completes and
rejection means closed-and-refused rather than never-connected. see "inbound connection
gating" for closing that hole.

chat contextual actions
-----------------------

type: usability
scope: chat, UI

chat's action bar reflects what can be done with the peer right now: connect when
disconnected, 🖕 and 👌 when that peer is requesting a connection and auto accept is off,
and call when connected. needs mockup frames for the three states.

connection state badges
-----------------------

type: usability
scope: roster, UI

connection state becomes a small filled circle at 5 o'clock on the peer's avatar: green
when connected, blue when the peer is online but not connected, grey when it was known
before but is not reachable now. the call badge takes that position while a call is in
progress, since a call implies a connection.

home loses its per-row connect button and its "not currently available" text — the badge
carries that meaning, and connecting happens from chat. needs the roster mockup updated and
a new StatusIndicator variant.

local peer settings view
------------------------

type: feature
scope: frontend views

a settings view for this peer's own behaviour, reached by tapping the local avatar in home's
status bar. it mirrors the peer view's structure but holds settings about us rather than
about them: whether connection requests are accepted automatically, and an editable display
name overriding the account username, stored under the local peer like any other peer's
name. needs a new mockup frame.

identity change notification
----------------------------

type: feature
scope: network services

the identity service is request/response only, so a display name change reaches a peer no
earlier than its next connection. give it an events facet that tells already-connected peers
when the local name changes, following how registry announces its catalog.

peer auto-connect
-----------------

type: feature
scope: frontend service, options

connect to peers marked for automatic connection whenever they become reachable, configured
per peer as `peers/{peerId}.auto_connect`, off by default. the control belongs on the peer
view but outside the service list — auto connect is a frontend behaviour, not a service that
is published to that peer.

inbound connection gating
-------------------------

type: hardening
scope: network

follow-up to "connection approval": deny unapproved inbound connections at the transport
instead of after the fact, so an unapproved peer never completes a connection. needs real
`connectionGater` hooks and a way to carry the decision into `createNetwork`, which today
takes a synchronous service-publication predicate that cannot wait for a person.

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

UI refinement
-------------

type: usability
scope: frontend views
state: largely delivered — mockups exist in penpot, `vessel/frontend/components` and
`vessel/frontend/layouts` are built, and the account views run on them. what remains is
tracked by "handheld view layout" and the tasks after it.

in order to provide pleasant experience Vessel's views should look good and intuitive.
currently Vessel's views are just pile of elements bound together.

consistency should be provided with general layout and reusable components:
- layout should be defined in main.tsx

  possibly there will be multiple layouts in future, but for now it should be simple:
  - navbar
  - taskbar (always on top)
  - toolbar
  - view

  responsiveness:
  - general layout: toolbar on the top below status bar
  - small screen devices: toolbar at the bottom


  toolbar provides tool buttons for current view:
  - home view: lock account, app settings (not yet implemented)
  - chat view: peer view, start call
  - peer view: peer settings, start call, back to home
  - peer settings views: back to previous view
  - call view: back to previous view

  taskbar show whether there is ongoing call and information about unread messages from peers.
  clicking on call should open call view.
  

- components should have their own directory in frontend (vessel/frontend/components)

  TODO(refinement): need to determine reusable components

TODO(refinement): provide mockups

no need in any additional information on home (like Brochain: private communication network) - keep it minimal, only functional data

advanced profiles
-----------------

besides just name profile should contain colors and picture.
picture should be of square size between 256x256 and 512x512 pixels

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

A call offers only the addresses a browser sees for itself, which suffices
inside one network and nowhere beyond it. Configure address discovery servers so
a peer learns the address it presents to the outside and can offer it as a
candidate. Refine where those servers are configured, whether Beacon advertises
its own, and what a reader is told when discovery fails, before implementation.

 - beacon should implement STUN server with kill-switch that allows to turn it off
 - in global settings view there should be a list of stun servers that are used to traverse NAT

call relay
----------

type: feature
scope: calls, beacon, network

Symmetric address translation defeats address discovery, and such a call can
only be carried by a relay. Decide whether Beacon relays call media as it
already relays connection establishment, and refine credentials, capacity, and
the limits a relay places on call quality before implementation.

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
