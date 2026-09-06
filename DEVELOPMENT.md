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
- `npm run deploy` validates, tests and builds as above, then ships the result to
  the server described under [deployment](#deployment).

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

Beacon announces `localhost` among the addresses it answers on, which is the name
a forwarded device dials, so the forward is all such a device needs. The other
announced addresses belong to this machine's networks and a forwarded device
simply fails to dial them, as it does any address off its own network.

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
- `BEACON_HOST` — the public host Beacon announces, at `443` over TLS, because a
  host reached by name from outside is reached through something which terminates
  it. Defaults to every address this machine answers on, at `PORT`, without TLS.
- `BEACON_IDENTITY`, `VESSEL_HOSTING`, and `BEACON_RELAY`, as above.

Vessel connects its default Beacon at its own origin, so a deployment that serves
the application also provides the relay unless it is told otherwise. It serves
plain HTTP, so a deployment reached by anything but `localhost` terminates TLS in
front of it — a browser withholds from an insecure page what an account needs —
and that deployment states `BEACON_HOST`, because the port Beacon listens on is
not the port anyone arrives at.


deployment
----------

A deployment is configured by `.env` beside the project, which is never committed
because the server named there belongs to whoever deploys rather than to the
project:

```sh
DEPLOY_HOST=administrator@bug.betaev.pub
DEPLOY_ORIGIN=https://bug.betaev.pub
```

`npm run deploy` refuses before it builds anything if either is missing. It then
type-checks, runs the whole test suite, builds Vessel, and:

1. streams a release — `dist`, `beacon`, `common` and the two dependency files —
   into `/srv/brochain/releases/<timestamp>`, so neither machine keeps an archive
2. installs that release's production dependencies there
3. makes it `/srv/brochain/current`, by making the link beside the current one and
   replacing it in a single step, because linking over a link which exists creates
   one inside it
4. restarts the service, which resolves that link afresh at every start
5. removes every release but this one and the one before it
6. fetches `DEPLOY_ORIGIN` and refuses the deploy unless it serves the very
   `index.html` just built

A deploy needs no privilege on the server. Preparing the server does, and is done
once, [below](#the-server).

Rolling back is relinking the release which stayed:

```sh
ssh administrator@bug.betaev.pub \
  'ln -sfn "$(ls -1dt /srv/brochain/releases/* | sed -n 2p)" /srv/brochain/next \
   && mv -T /srv/brochain/next /srv/brochain/current \
   && systemctl --user restart brochain'
```

`journalctl --user -u brochain -f` on the server is what the relay reports.

### confirming a deployment

A deploy proves the application is served; it cannot prove peers can reach each
other, because the bootstrap connection succeeds whatever Beacon announces. After
the first deploy, and after any change to `BEACON_HOST`, the proxy or the domain:

1. the site loads and Chrome offers to install it
2. an account signs in and Home reports no networking failure
3. **the Beacon's peer page shows `/dns4/bug.betaev.pub/tcp/443/tls/ws`** — nothing
   else catches an announcement which disagrees with the address people arrive at,
   and every peer-to-peer connection depends on it
4. two devices on different networks find each other, connect, and exchange a
   message and a file
5. a call between those two networks connects
6. a second deploy reaches an installed application without a manual reload

the server
----------

Prepared once, on Debian, for the domain it answers on. Beacon needs Node
`22.20.0`, which Debian does not package.

```sh
sudo apt update && sudo apt install -y nginx certbot ufw

curl -fsSLO https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.xz
sudo mkdir -p /usr/local/lib/nodejs
sudo tar -xJf node-v22.20.0-linux-x64.tar.xz -C /usr/local/lib/nodejs
sudo ln -sfn /usr/local/lib/nodejs/node-v22.20.0-linux-x64/bin/node /usr/local/bin/node
sudo ln -sfn /usr/local/lib/nodejs/node-v22.20.0-linux-x64/bin/npm /usr/local/bin/npm

# Releases live where the web server can reach them, which a home directory
# withholds, and are owned by whoever deploys so a deploy needs no privilege.
sudo install -d -o administrator -g administrator -m 0755 \
  /srv/brochain /srv/brochain/releases
```

The certificate is issued against a server block which serves only the challenge,
and the one below replaces it once the certificate exists:

```sh
sudo mkdir -p /var/www/certbot
sudo certbot certonly --webroot -w /var/www/certbot -d bug.betaev.pub
sudo systemctl enable --now certbot.timer
printf '#!/bin/sh\nsystemctl reload nginx\n' \
  | sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
```

`/etc/nginx/sites-available/brochain` terminates TLS, serves the built application
and hands Beacon the WebSocket upgrades, which is `VESSEL_HOSTING=off`:

```nginx
map $http_upgrade $connection_upgrade { default upgrade; "" close; }

server {
    listen 80;
    listen [::]:80;
    server_name bug.betaev.pub;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name bug.betaev.pub;

    ssl_certificate /etc/letsencrypt/live/bug.betaev.pub/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bug.betaev.pub/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    root /srv/brochain/current/dist;

    gzip on;
    gzip_vary on;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_types text/css application/javascript application/manifest+json image/svg+xml;

    # An upgrade arrives at the path the application is served from, so it goes to
    # the relay and everything else to disk. `return` is the only directive safe
    # inside `if`, and `try_files` would otherwise claim the request first.
    location / {
        error_page 418 = @relay;
        if ($http_upgrade) { return 418; }

        add_header Strict-Transport-Security "max-age=31536000" always;
        add_header Cache-Control "no-cache" always;
        try_files $uri /index.html;
    }

    # A hashed name changes whenever its content does, so a browser may keep it.
    # A header set here replaces rather than joins the ones above.
    location ~ "^/(assets/|workbox-[^/]+\.js$)" {
        add_header Strict-Transport-Security "max-age=31536000" always;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        try_files $uri =404;
    }

    location = /manifest.webmanifest {
        default_type application/manifest+json;
        add_header Strict-Transport-Security "max-age=31536000" always;
        add_header Cache-Control "no-cache" always;
    }

    location @relay {
        proxy_pass http://127.0.0.1:4173;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        # A connection carrying nothing is still a connection, and an application in
        # the background sends no keep-alive at all because its timers are stopped.
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
```

`~/.config/systemd/user/brochain.service` runs the relay as the user which
deploys, so restarting it needs no privilege. The identity is named outside every
release, because a release is replaced and the relay's identity must not be:

```ini
[Unit]
Description=brochain Beacon

[Service]
WorkingDirectory=/srv/brochain/current
Environment=PORT=4173
Environment=VESSEL_HOSTING=off
Environment=BEACON_HOST=bug.betaev.pub
Environment=BEACON_IDENTITY=/srv/brochain/beacon-identity
ExecStart=/usr/local/bin/node beacon/main.ts
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
```

```sh
sudo loginctl enable-linger administrator   # the service outlives a login
systemctl --user daemon-reload
systemctl --user enable brochain            # not start: no release exists yet

# Beacon listens on every address so the proxy can reach it, and nothing else
# should.
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw --force enable
```

The first start writes `/srv/brochain/beacon-identity`. **Keep a copy of it**: the
relay refuses an identity it cannot read rather than taking a new one, and a new
one discards every roster entry, name and service decision every peer holds about
it.
