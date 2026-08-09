development instructions
========================

runtime
-------

Use Node.js `22.20.0` through NVM. The repository's `.nvmrc` selects that version.

```sh
nvm use
```

commands
--------

The three project commands install or refresh dependencies automatically when needed.

- `npm run dev` starts Vessel and its local default Beacon. Open the Vessel address printed by the command; Beacon listens on port `9090` by default.
- `npm run prod` validates and builds Vessel, then serves it with the production Beacon.
- `npm run test` runs the complete project test suite.

production configuration
------------------------

`npm run prod` accepts:

- `PORT` — Vessel's public application port; defaults to `4173`.
- `BEACON_RELAY_PORT` — Beacon's local relay listener port; defaults to `9090`.
- `BEACON_PUBLIC_RELAY_PORT` — externally reachable relay port announced by Beacon and embedded in the Vessel build; defaults to `BEACON_RELAY_PORT`.
- `BEACON_HOST` — public DNS host announced by Beacon; defaults to `localhost`.
- `TLS_CERT_PATH` and `TLS_KEY_PATH` — set both to enable HTTPS for Vessel and WSS for Beacon.

Vessel connects its default Beacon at the application's hostname and configured public relay port. Remote browser deployments MUST expose that relay on the same host, configure matching public relay and Beacon values, and use TLS. Unencrypted operation is appropriate only for localhost development.
