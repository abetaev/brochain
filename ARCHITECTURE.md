architecture
============

brochain consists of the browser application **Vessel** and a headless bootstrap and relay peer, **Beacon**.

```text
Vessel
├── Account
└── Session
    ├── Network (local peer)
    ├── Registry
    │   └── Peer (one per known remote peer)
    ├── Storage
    ├── Identity
    └── Messaging

Beacon
├── Network (local peer)
├── Registry
└── Circuit relay
```

Vessel
------

### Account

- **runtime**: Web Worker; Comlink projects its API into the Window
- **behavior**: list, create, unlock, export, and password-confirmed deletion of local accounts; create and unlock produce a Session
- **storage**: IndexedDB holds v2 account records; PBKDF2 and AES-GCM protect the peer identity seed
- **boundary**: password handling, account decryption, and derived keys remain in the Worker; the public Account API exposes no identity material, while the active Session receives its identity seed through a private endpoint

### Session

- **runtime**: Window
- **dependency**: one unlocked Account identity
- **behavior**: owns the authenticated Network, Registry, Storage, Identity, and Messaging lifetime; sign-out closes peer networking and the Account session

### peer model

| Entity | Responsibility | Technology |
| --- | --- | --- |
| **Network** | Represents the local peer, connects configured bootstrap addresses, hosts named services, and owns the libp2p lifetime. | libp2p, Noise, Yamux, Identify |
| **Registry** | Creates and retains one Peer per remote identity, discovers through connected peers, and shares connected peers through its hosted service. Successful discovery is cached for five minutes; known peers remain for the Session. | Named peer services |
| **Peer** | Represents one remote identity and its addresses, advertised services, direct connection state, connection events, explicit connection, and remote service access. | libp2p multiaddresses |
| **RPC** | Projects named peer services over authenticated direct connections; values may contain JSON-compatible data and bytes. | typed-rpc over a versioned libp2p protocol |

Vessel's Network uses WebSockets and Circuit Relay v2 to reach Beacon, then WebRTC for direct browser-to-browser connections. `RTCPeerConnection` keeps this runtime in the Window.

### Session services

| Service | Dependency | Behavior | Storage |
| --- | --- | --- | --- |
| **Storage** | none | Provides event and current-value storage scoped by remote peer and service. | Memory; discarded with the Session |
| **Identity** | Peer, Storage | Publishes the local username and validates and caches remote usernames. | One cached value per remote peer |
| **Messaging** | Peer, Storage | Sends and receives text and files, records outgoing messages immediately, preserves per-peer delivery order, and records failures. | Session event history per remote peer |

Every Network also hosts service discovery. A Registry may host peer discovery, allowing connected peers to share their currently connected peers without connecting the discovered peers implicitly.

### UI

- **dependencies**: Account and the active Session
- **behavior**:
  - **Account** — create, unlock, export, and delete accounts
  - **Home** — bootstrap, discover and explicitly connect peers, show connection and unread state, and sign out
  - **Chat** — send and display one messaging-capable peer's text and files
- **technology**: SolidJS, Pico CSS, advisory zxcvbn password strength, and a Vite-generated PWA shell

```text
Account --create/unlock--> Home --open peer--> Chat
Account <--sign out------- Home <--back------- Chat
```

Beacon
------

- **runtime**: Node.js
- **behavior**: runs the common Network and Registry, hosts peer discovery, and relays peer traffic without storing application messages
- **technology**: libp2p, WebSockets, Circuit Relay v2, Noise, Yamux, Identify, and Identify Push
- **operation**: development starts Beacon beside Vessel; production serves the built Vessel and runs Beacon in the same process
