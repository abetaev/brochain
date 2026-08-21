development backlog
===================


This document contains:
 - [tasks](#tasks) - requirements to be implemented
 - [thoughts](#thoughts) - drafts of tasks and ideas for future development

Implemented behavior is described in [README.md](./README.md) and [ARCHITECTURE.md](./ARCHITECTURE.md).

tasks
=====

move assets around
------------------

type: refactoring
scope: frontend

`vessel/index.html` and `public/icon.svg` should be located in `vessel/frontend`

favicon is not visible
----------------------

type: bug
scope: frontend

favicon is not visible neither in dev nor in prod mode.

terminology and structure adjustments
-------------------------------------

type: design, refactoring, architecture
scope: backend, core, services

`backend` components are:
 * account
 * network
 * session
 * storage
 * options

`roster` is frontend service and should be moved to frontend/services directory within vessel.

frontend structure
------------------

type: refactoring
scope: frontend

frontend should be organized in the following way:
 - `vessel/frontend` should contain only index.html, relevant stylesheet if applicable, main.tsx and icon.svg
 - `vessel/frontend/views` should contain all existing views
 - `vessel/frontend/services` should contain frontend services (currently only `roster`)

persistent storage
------------------

type: feature
scope: backend services

storage should provide 2 modes of operation:
 * in-memory
 * persistent


configuration service
---------------------

type: feature
scope: backend services

`options` service uses persistent kv storage to store configuration settings.

each property has name key is arbitrary string consisting of:
 - term characters (`[A-Za-z0-9-_]`) - used for naming entities
 - special characters:
   - dots (`.`) - defines properties of objects, one object may be property of another
   - slashes (`/`) - defines collections of objects, one collection may be embedded into another, but it cannot be embedded into object
     - collections may have properties, i.e. terms which follow `/` may also follow `.`

do not enforce naming, just document convention

settings frontend
-----------------

type: feature
scope: frontend services, components, UI

UI should provide generic way for its views to configure behavior of underlying frontend services.

for this moment there should be at least `roster` service which should allow the following configuration:
 - toggle service availability for a peer
   property location: `peers/${peerId}/services/${serviceName}.enabled: boolean`


persistent roster
-----------------

type: feature
scope: frontend services/roster, configuration

roster should start leveraging persistent storage to remember names of peers.

initially when peer is discovered we know just its id.

when connection is established and if peer exposes identity service then roster should remember this identity.

next time when peer is discovered roster should show peer's username instead of peerid.

> **future consideration**: it should be possible to assign arbitrary names to peers in future, but information from identity service should always be kept for reference/information.

at this step the following configuration should be introduced:
 - peer's cached identity
   property: `peers/${peerId}/identity` - whole identity object returned by peer's identity service (if exposed)
 - peer's display name
   property: `peers/${peerId}.display_name : string = ${peers/${peerId}/identity.username}`

peer display_name customization
-------------------------------

type: feature
scope: frontend services & views - roster, configuration

`peers/${peerId}.display_name` property is source of truth for how to show peer in roster.

there should be a way to rename peer in local configuration, i.e. change `display_name` associated with `peerId`.

network service collection
--------------------------

type: feature
scope: network

network services should be standardized to allow compatibility validation.

all network services should be published using a single collection object
```ts
type Services = Record<string, Service>
```

Local Peer supposed to publish whole or partial object and validate which of supported services are available for it.
So when peers connect they publish to each other services based on configuration.





message confirmations
---------------------

type: feature
scope: network/services/messaging, UI

when peer A reads message from peer B it MAY send confirmation to peer B about message receipt.

upon receiving confirmation UI must reflect message receipt. 

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
