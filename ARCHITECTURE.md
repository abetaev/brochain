architecture
============

brochain consists of a browser-based `vessel` and a Node.js `beacon` in one npm project.

vessel
------

`vessel` is a Vite-built SolidJS progressive web application. Pico CSS supplies the classless base styling, and `vite-plugin-pwa` generates the manifest and service worker.

### accounts

- account metadata (`id`, display name, and creation time) is stored in IndexedDB.
- account secrets are encrypted with Web Crypto PBKDF2-HMAC-SHA-256 (310,000 iterations) and AES-GCM.
- an account's encrypted secrets contain a 32-byte Ed25519 identity seed and the corresponding libp2p peer ID. The private key is deterministically recreated only after the account is unlocked.
- exports contain the encrypted account record. Account names remain local display metadata so the account-selection view can be shown before unlock.

### peer networking

When an account is unlocked, the vessel creates a libp2p node with its persisted identity. It connects to the beacon through WebSockets, reserves a Circuit Relay address, and accepts or dials WebRTC connections. Noise encrypts and authenticates libp2p connections; Yamux multiplexes streams.

The vessel publishes its current WebRTC multiaddress and display name to the beacon's peer directory. It refreshes the directory on demand and republishes its presence every ten seconds. A user can also paste a peer multiaddress for a direct connection.

Chat uses the `/brochain/chat/1.0.0` libp2p protocol. Each stream carries one JSON packet: either text or a file packet with base64-encoded file content. Chat data is transmitted directly over the established peer connection and is not persisted locally.

beacon
------

The beacon is a Node.js libp2p Circuit Relay v2 node using a WebSocket transport, Noise, and Yamux. It also exposes an in-memory HTTP peer directory:

- `GET /api/beacon` returns the relay multiaddress.
- `GET /api/peers?exclude=<peer-id>` returns active peers other than the caller.
- `POST /api/peers` registers or refreshes a peer's advertised WebRTC addresses.

Peer registrations expire after 30 seconds unless refreshed. The directory is for discovery only; it does not relay chat content.

In development, the beacon is started by a Vite plugin and its HTTP API is attached to Vite's middleware. In production, root-level `main.ts` starts the static vessel server and the relay. The relay listens separately from the vessel's HTTP server.

deployment security
-------------------

Local development uses HTTP and WS. Remote deployments should enable the certificate configuration described in [development instructions](DEVELOPMENT.md), which makes the vessel HTTPS and the relay WSS. This is required for browser Web Crypto and secure WebSocket use outside localhost.
