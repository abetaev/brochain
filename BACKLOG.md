abstract
========

project development backlog.

After a task is completed, remove it from this development plan. Update [user documentation](README.md) and [technical architecture](ARCHITECTURE.md) only with the actual technical decisions and implementation resulting from that task; do not move or copy the task itself there.

tasks
=====

the following tasks are intended to streamline application architecture to produce patterns useful for further application development. this is set of tasks under code name "MVPv2"

project layout and DX
---------------------

class: DX

project should have 2 distinct directories in its root:
- `beacon` - directory containing all necessary source files to run beacon
- `vessel` - all vessel PWA sources
if necessary, there can be `common` directory that contains source files for both components

project should remain single module NPM project and run same way as it runs

there should be just 2 scripts in package.json - `dev` and `prod`, both should not require any additional commands, i.e. they should run `npm install` or any other command to initialize project if needed. to mark that project initialization is complete they will leave `.i` gitignored marker in root of the project.


password strength validation improvement
----------------------------------------

class: UI, code-reduction

use https://github.com/zxcvbn-ts/zxcvbn to validate password strength instead of custom implementation

draw 4 scale bar that shows red-orange-yellow-green color depending on password strength

account service architecture
----------------------------

class: technical, architecture

instead of spreading work with accounts encapsulate it into a single service

account service should provide the following features:

- create account (username, password)

- unlock account (username, password) -> unlocked account

- delete account (username, password) -> success/failure

- list accounts -> username[]

network service architecture
----------------------------

class: technical, architecture


network service should encapsulate network operations that are available for accounts:

- beacon operations
  - connect to beacon (url)
  - list connected beacons -> beacon[] 
- peer operations
  - connect to peer (peerId)
  - list connected peers -> peer[]

each peer object should encapsulate actions available to peer:
- send message/file
- on message/file

vessel architecture
-------------------

vessel should consist of 2 parts:
- frontend - UI that provides access to user functions:
  - peer discovery
  - message/file exchange
- backend - set of services that provide functionality for UI
  - account service
  - network service

these two parts should be distinct

security design
---------------

class: architecture, security

to provide best of security all sensitive information should be stored in web worker memory

services that operate with sensitive information (peerId, passwords, encryption keys, etc...) should use thin proxy to web worker runtimes which would run service implementation in secure isolated environment.

ui architecture
---------------

class: architecture, UX

UI should follow design convention that is:

- view - a wholesome page that contains complete functionality to support specific set of use cases:
  - account view - page where user who opened the app find themselves in the first place
    - registration view - page where user creates new account; after registration user is automatically logged into created account - no need to enter password again
    - login view - user enter password for account selected on account view
  - home view - network discovery roster - user can browse other peers available on network; connected peers have green dot indicating active connection
    - chat view - user can exchange messages and files with selected peer

network architecture (considerations for further development; to be refined)
----------------------------------------------------------------------------

class: feature

beacon is supposed to be used for bootstrap connection only, peers that are connected should be able to use p2p discovery instead of relying on beacon.

in further versions of application (post MVPv2):
- p2p discovery: peers should be able to run network queries to perform discovery of second, third and higher order peers: if peer1 knows peer2 and peer2 knows peer3, then peer3 is second level peer for peer1. foundation for this can be laid in MVPv2, but implementation will take place later.
- real-time connection: peers should be able to make WebRTC calls (voice and video) to directly connected peers on the network
  - further development of real-time connection should provide smart-routing capability for multi-user calls; such capability should allow users to user peers to route webrtc traffic for reduction of latency and traffic, e.g. if peer1, peer2 and peer3 are on call, peer1 can send their stream to peer2 and peer2 can send both streams to peer3, instead of peer1 sending 2 streams to peer2 and peer3; routing should use latency to determine which peer should be responsible for stream deliveries (this is probably a separate feature, but useful for consideration)

test architecture (consideration for future development)
--------------------------------------------------------

class: quality control, functional decomposition, architecture

project should contain high-level tests that validate its functions.

tests should use playwright in their core.

each test should be clear example of how application is intended to be used.

storage design (considerations for future development)
------------------------------------------------------

class: feature, architecture

there should be 2 types of storages:
- file storage - backed by zenfs
  - versioned file storage backed by isomorphic.git on zenfs
- metadata storage backed by indexeddb

file storage will provide key-value access to big chunks of data (e.g. videos, audios, pdfs, etc... - whatever is considered a file)

metadata storage will provide querying functionality for files on file storage.