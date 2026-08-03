development instructions
========================

runtime
-------

Use Node.js `22.20.0` through NVM. The repository's `.nvmrc` selects that version.

```sh
nvm use
npm install
```

commands
--------

- `npm run dev` starts the Vite vessel and its embedded beacon. The vessel is served on Vite's port and the relay uses port `9090` by default.
- `npm test` runs the Vitest behavior and storage tests.
- `npm run typecheck` validates TypeScript without emitting files.
- `npm run build` type-checks and creates the production vessel in `dist/`.
- `npm run check` runs typecheck, tests, and a production build.
- `npm run prod` starts root `main.ts`, which serves `dist/` and starts the production beacon. Run `npm run build` first.

testing
-------

Tests use Vitest, jsdom, Solid Testing Library, and fake-indexeddb. Test observable account and peer workflows; keep relay and protocol tests focused on their units. Use the production and development commands for live relay smoke checks when port binding is available.

The relay-backed WebRTC integration check is opt-in because it opens a local relay port:

```sh
npm run test:network
```

production configuration
------------------------

`npm run prod` accepts these environment variables:

- `PORT` — vessel HTTP or HTTPS port; defaults to `4173`.
- `BEACON_RELAY_PORT` — relay listener port; defaults to `9090`.
- `BEACON_PUBLIC_RELAY_PORT` — externally advertised relay port; defaults to `BEACON_RELAY_PORT`.
- `BEACON_HOST` — public DNS host advertised in relay multiaddresses; defaults to `localhost`.
- `TLS_CERT_PATH` and `TLS_KEY_PATH` — set both to enable HTTPS for the vessel and WSS for the relay.

Remote browser deployments MUST set both TLS paths and advertise a DNS host reachable by clients. Plain HTTP and WS are appropriate only for localhost development.
