abstract
========

project development backlog.

After a task is completed, remove it from this development plan. Update [user documentation](README.md) and [technical architecture](ARCHITECTURE.md) only with the actual technical decisions and implementation resulting from that task; do not move or copy the task itself there.

> **GREENFIELD PROJECT NOTICE:** project is currently empty; upon implementing MVP this notice MUST be removed;
> this notice is provided for AI agent awareness only.

tasks
=====

> **TASK BOUNDARY:** each section below describes one indivisible functional task. During refinement, the AI agent may derive internal execution increments and add agreed detail to this section, but MUST NOT create separately tracked backlog tasks unless the engineer explicitly changes this boundary.

MVP
---

### use cases

- **account management**:
  - **create account**: user can register
    * user's account is stored in application's storage
    * user's password used to encrypt account information
    * if no accounts exist **create account** should be the only default view
  - **login**: user can log into existing account using correct password
    * when user logs in they see list of peers that are discoverable
    - user can connect to a chosen peer
- **connect**: user can connect to any peers discovered through beacon or direct connection
- **chat**: user can exchange text messages and files with connected peers 

### structure

whole codebase should be a single non-dividable NPM project with just one package.json and 2 modes of running:
- `dev`
- `prod`

#### vessel

progressive web application

##### tech stack

- solidjs for UI
  - picocss (classless)
- libp2p for communication
- indexeddb for storage

#### beacon

simple web-server that provides way for vessels to perform initial peer discovery and establish connection with other peers on the network.

beacon runs in 2 modes:
 - development mode: embedded into dev server (vitejs)
 - production mode: runs as standalone application (HTTP server, particular implementation can be HAPI, express, just core nodejs depending on complexity needs)

##### tech stack

- libp2p for discovery and relay connections
- HTTP server for communication
- containerize (docker?) for production mode

#### functional behavior

##### main scenario

1. user opens web page with `vessel`
2. user logs in (see `account management` scenario)
2. after user successfully logged in app on that page connects to `beacon` using account's peerid and retrieves list of available peers 
3. if peers are available user may choose any of them to connect to
4. after user connected to another peer, they can send and receive messages

##### account management

- when user first opens app there are no accounts - user is explicitly asked to enter account name and password - `create account` view (with confirmation + complexity bar component to show reliability of the chosen password)
- when there is at least one account `vessel` shows web page that has list of accounts and a button to create new one 
  - if user choses to create new account they go to the `create account` view
  - if user choses existing account they are asked for password to decipher account's data
  - each account entry has 2 additional buttons:
    - delete - removes account from local storage
    - export - downloads encrypted account onto user's device

#### technical behavior

technical behavior varies depending on mode in which application is running

##### `dev` mode

in development mode application should run using vitejs development server and provide websocket for libp2p to do signalling between `vessels` over `beacon`

##### `prod` mode

in production mode `beacon` should run via `main.ts` script located in project's root. that script should run regular http server for hosting/distribution of `vessel` and websocket (preferably via same tech stack) to provide signalling channels for libp2p connection bootstrapping.