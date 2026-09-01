development backlog
===================


This document contains:
 - [tasks](#tasks) - requirements to be implemented
 - [thoughts](#thoughts) - drafts of tasks and ideas for future development

Implemented behavior is described in [README.md](./README.md) and [ARCHITECTURE.md](./ARCHITECTURE.md).

tasks
=====

development across a local network
----------------------------------

type: infrastructure
scope: project commands

The development server listens on the loopback address, so a second machine
cannot reach a running Vessel and nothing involving two real devices can be
tried. Bind it to every interface, and document reaching it including the Beacon
host, which MUST announce an address the other machine can dial.

peer to peer calls
------------------

type: feature
scope: network services, frontend services, views, application

Add one to one audio and video calls between two connected peers.

Media cannot travel over the connection a peer already has: the libp2p WebRTC
transport owns its peer connection, exposes neither it nor a way to renegotiate
it, and carries data channels alone. A call therefore establishes a second peer
connection and signals it over the connection which already exists.

- A `calling` Network Service carries that signalling: session descriptions,
  address candidates, and ending a call. It is published per peer like every
  other service, so refusing it in Peer refuses calls with that peer.
- A `call` Frontend Service owns the media. It captures local audio and video,
  holds the peer connection, and keeps the call for the Session. It is
  constructed at sign-in beside Roster and Chat, so a call reaches a reader
  whatever they are looking at.
- A `Call` view shows local and remote video and offers muting, stopping the
  camera, and hanging up. Leaving the view MUST NOT end the call, and the
  application MUST show that a call is running while another view is open.
- Chat offers a call beside sending text and files, enabled only while that peer
  publishes the service.
- An incoming call MUST be accepted before capture begins: a reader consents to
  their camera and microphone rather than having them taken.
- A call which cannot establish a media path MUST report that plainly rather
  than appearing to connect.

One call at a time is enough. A call belongs to the peer it is with, so no call
identifier is needed until several may run at once.

Calls reach only a local network until the address discovery and relay tasks
land.

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

standalone Beacon process
-------------------------

type: infrastructure
scope: beacon, project commands, tests

Beacon has no entry point of its own. The development server imports its plugin
from the Vite configuration, so the configuration loader bundles `beacon/core.ts`
and the whole of `common/backend/network` into one temporary module whose scripts
carry no attributable file names. Nothing can measure what Beacon exercises, and
no workflow can start or stop one.

Give Beacon its own entry point and start it as a process:

- Workflows start Beacons directly, so one Vessel development server serves every
  workflow instead of the second one which exists today only to announce a relay
  port where nothing listens.
- A workflow MAY then stop and restart a Beacon, which reconnection behaviour
  needs.
- Collect the process coverage through `NODE_V8_COVERAGE` and merge it into the
  workflow report. Node strips types in place, so recorded lines already match the
  source and no source map is required.

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
