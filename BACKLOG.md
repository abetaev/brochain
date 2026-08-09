development backlog
===================

Only unfinished requirements and provisional decisions belong here. Implemented behavior is described in [README.md](./README.md) and [ARCHITECTURE.md](./ARCHITECTURE.md).

MVPv2
=====

MVPv2 remains one indivisible unit of work even when implemented iteratively. Only the engineer's explicit completion declaration removes this section.

message confirmations
---------------------

class: feature, protocol, UI

Text and file messages need sender-visible confirmation when the recipient:

- receives the message
- reads the message

Sending MUST update the sender's Chat immediately without waiting for either confirmation. Before implementation, refine message identity, acknowledgement semantics, failure and retry behavior, duplicate handling, and session retention. Confirmations do not imply offline delivery or storage.

future
======

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
