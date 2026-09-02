development instructions
========================

This document provides instructions for developers who want to contribute to project.

runtime
-------

Use Node.js `22.20.0` through NVM. The repository's `.nvmrc` selects that version.

```sh
nvm use
```

commands
--------

The three project commands install or refresh dependencies automatically when needed.

- `npm run dev` starts Vessel and its default Beacon over HTTPS on one port, generating a certificate for this machine into `dev` on first run. Open an address printed by the command and accept that certificate. The server listens on every interface, so the network address it prints reaches another device.
- `npm run prod` validates and builds Vessel, then serves it with the production Beacon.
- `npm run test` runs the complete project test suite: the lower-level tests
  first, then the browser workflows, which start their own servers on dedicated
  ports and are given a synthetic camera and microphone so a call can be placed
  without one. Each set reports its coverage separately, under `coverage/unit`
  and `coverage/workflows`.

another device
--------------

Vessel is served over HTTPS in every run mode, because a browser withholds
`crypto.subtle`, Web Locks and private file storage from anything less and an
account cannot even be created without them. `http://localhost` would count as
secure and a network address never does, so one mode covers both.

Development generates its own certificate with `openssl`, covering loopback and
every address this machine answers on, and keeps it in `dev` until those
addresses change. Set `TLS_CERT_PATH` and `TLS_KEY_PATH` to use a certificate of
your own instead.

Open the printed network address on the other device and accept the certificate
once. Vessel and its Beacon answer on the same port, so there is one origin to
trust and one exception to grant.

Beacon announces loopback together with every address of the machine, so both
devices find one they can dial. `BEACON_HOST` replaces that list when set, for
the certificate and the announcement alike.

capabilities
------------

A server does two things, and either can be switched off:

- `VESSEL_HOSTING=off` serves no application. What remains is a relay for
  applications hosted elsewhere.
- `BEACON_RELAY=off` provides no relay. What remains is an application host whose
  people reach a Beacon by address.

Both are on by default, which is the single-machine arrangement `npm run dev`
starts. The browser workflows use the second to meet a Vessel host that offers no
Beacon of its own.

production configuration
------------------------

`npm run prod` accepts:

- `PORT` — the port Vessel and the relay share; defaults to `4173`.
- `BEACON_HOST` — the public host announced by Beacon; defaults to every address
  this machine answers on.
- `TLS_CERT_PATH` and `TLS_KEY_PATH` — the certificate to serve. A certificate is
  generated into `dev` when they are unset, which is meant for development only.
- `VESSEL_HOSTING` and `BEACON_RELAY`, as above.

Vessel connects its default Beacon at its own origin, so a deployment that serves
the application also provides the relay unless it is told otherwise.
