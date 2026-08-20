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

service is the smallest application on brochain platform.

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

persistent roster
-----------------

type: feature
scope: frontend services/roster

roster should start leveraging persistent storage to remember names of peers.

initially when peer is discovered we know just its id.

when connection is established and if peer exposes identity service then roster should remember this identity.

next time when peer is discovered roster should show peer's username instead of peerid.

> **future consideration**: it should be possible to assign arbitrary names to peers in future, but information from identity service should always be kept for reference/information.


configuration service
---------------------

type: feature
scope: backend services

`options` service uses persistent kv storage to store configuration settings.

each setting has name key in format `(\w+\.)?\w+`, i.e. similar to java `.properties` files.

settings frontend
-----------------

type: feature
scope: frontend services, components, UI

UI should provide generic way for its views to configure behavior of underlying frontend services.

for this moment there should be at least `roster` service which should allow the following configuration:
 - select list of services provided to specific peer

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
