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

- `npm run dev` starts Vessel and its default Beacon on one port. Open `http://localhost` at that port; reaching it from another device is below.
- `npm run prod` validates and builds Vessel, then serves it with the production Beacon.
- `npm run test` runs the complete project test suite: the lower-level tests
  first, then the browser workflows, which start their own servers on dedicated
  ports and are given a synthetic camera and microphone so a call can be placed
  without one. Each set reports its coverage separately, under `coverage/unit`
  and `coverage/workflows`.

another device
--------------

A browser withholds `crypto.subtle`, Web Locks and private file storage from a
page it does not consider secure, and an account cannot be created without them.
`http://localhost` counts as secure wherever it is opened and a network address
never does, so another device reaches Vessel at its own `localhost`, forwarded to
this machine, rather than at this machine's address.

Android does that through the debugging bridge, which forwards a port on the
device to one here:

```sh
adb reverse tcp:5173 tcp:5173
```

The device then opens `http://localhost:5173` and reaches this server, one
browser or all of them, because the forward belongs to the device rather than to
a browser. Vessel and its Beacon answer on the same port, so one forward carries
both.

`BEACON_HOST` sets the host Beacon announces, which a forwarded device needs
pointed at the name it dials:

```sh
BEACON_HOST=localhost npm run dev
```

installing on another device
----------------------------

Every run mode serves the web app manifest and the service worker an installation
needs, development included. A browser that accepts them offers to install the
application rather than to bookmark it, and the installed application opens on
its own instead of in a browser. A forwarded `localhost` is secure enough to be
installed from; this machine's network address is not.

Which browser offers it is the browser's own decision, and two of them decline
whatever the manifest says. Desktop Firefox supports no installation at all.
Firefox for Android does, but requires HTTPS and refuses a plain origin even
where the browser itself treats it as secure, so a forwarded `localhost` is
installable in Chrome and not in Firefox. A manifest is therefore confirmed in
Chrome, and neither Firefox says anything about it.

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

beacon identity
---------------

The relay keeps one identity across restarts, so people who met it keep the peer
they already know. It is a seed generated at the first start and retained in
`.beacon-identity` beside the project, which `npm run dev` and `npm run prod`
share because one deployment has one relay.

`BEACON_IDENTITY` names that file, so a deployment supplies its own by pointing at
one or mounting one there, and replaces an identity by replacing or deleting the
file. A file which holds no valid seed is refused rather than replaced:
development then serves Vessel without a relay, and the Beacon process reports the
error and does not start.

production configuration
------------------------

`npm run prod` accepts:

- `PORT` — the port Vessel and the relay share; defaults to `4173`.
- `BEACON_HOST` — the public host announced by Beacon; defaults to every address
  this machine answers on.
- `BEACON_IDENTITY`, `VESSEL_HOSTING`, and `BEACON_RELAY`, as above.

Vessel connects its default Beacon at its own origin, so a deployment that serves
the application also provides the relay unless it is told otherwise. It serves
plain HTTP, so a deployment reached by anything but `localhost` terminates TLS in
front of it — a browser withholds from an insecure page what an account needs.
