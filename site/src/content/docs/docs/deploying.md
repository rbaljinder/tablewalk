---
title: Deploying
description: 'Run tablewalk for a team: the container image, a mounted config, the two network settings that matter, and running behind a proxy that signs people in.'
---

The container image runs the same browser as `npx tablewalk`, reading its connections from a mounted `tablewalk.json`.

```sh
docker run --rm -p 127.0.0.1:4111:4111 -v "$PWD/config:/config:ro" ghcr.io/rbaljinder/tablewalk
```

Then open `http://localhost:4111`. Each release is tagged with its version and `latest`; pin the version in anything that should not move.

## Configuration is a mount

The image holds no connections and no database. Everything comes from `/config`:

| Path in the container | Holds |
| --- | --- |
| `/config/tablewalk.json` | Connections, and any shared views, pages, layouts and queries |
| `/config/tablewalk/layouts.json` | Record layouts saved from the browser |
| `/config/tablewalk/pages.json` | Pages saved from the browser |
| `/config/tablewalk/credentials.json` | Passwords, if you use a file (mode `0600`) |

Mount it read-only (`:ro`) if nobody should save layouts or pages from the browser. A SQLite file goes in its own mount, such as `-v "$PWD/data:/data:ro"`, named in the config as `/data/app.db`.

## Passwords in a container

There is no keychain in a Linux container, so put the password in the environment and refer to it from the URL:

```json
{ "connections": [{ "name": "app", "url": "postgres://app:${APP_DB_PASSWORD}@db:5432/app" }] }
```

```sh
docker run -e APP_DB_PASSWORD=… …
```

An unset variable stops the server with the variable named, rather than failing to authenticate. The browser is only ever sent a redacted address.

## Two network settings to get right

**Publish to the host's loopback only.** Inside the container tablewalk binds `0.0.0.0`, because loopback in a container is reachable by nothing outside it. It warns about that at startup, and the warning is right. The publish flag is where you confine it:

```sh
-p 127.0.0.1:4111:4111     # right
-p 4111:4111               # every interface of the host machine
```

**Name the hosts people reach it by.** tablewalk answers only for loopback names and the interface it is bound to, which defends against DNS rebinding. Reached as `tablewalk.internal` or through a proxy, every request is refused with a message naming the fix. Add the names you use:

```sh
docker run -e TABLEWALK_ALLOWED_HOSTS=tablewalk.internal,data.example.com …
```

or `--allowed-host`, repeatable. A name without a port matches any port; matching is exact, with no wildcards.

Bound beyond loopback, the page can no longer use `${VARIABLES}`, the keychain or file paths when someone adds a connection, and cannot save the config. Put the connections a deployment should have in the mounted file.

## Behind a proxy

Terminate TLS at the proxy, pass the original `Host` through (`proxy_set_header Host $host;` in nginx), and add the public name with `--allowed-host`. To serve tablewalk under a path, such as `https://example.com/tools/`, set `--base-path /tools`.

tablewalk has no sign-in of its own. Put it behind a proxy that signs people in (Cloudflare Access, oauth2-proxy and the like) and tell it which header carries the user:

```sh
tablewalk --host 0.0.0.0 --allowed-host data.example.com \
  --auth-proxy-header X-Forwarded-User --auth-proxy-from 10.0.0.7
```

A request from beyond loopback without that header is refused, and every write in the journal carries its value. The header is believed only from loopback and the peers `--auth-proxy-from` names, so give it the proxy's own address. Loopback stays exempt, so the container's health check keeps working.

## Health and shutdown

`GET /healthz` says the process is up and `GET /readyz` says it can serve. The image's `HEALTHCHECK` polls `/healthz`. On SIGTERM, `--drain-delay` keeps `/readyz` answering 503 for a few seconds so a load balancer takes the instance out first, and `--shutdown-grace` bounds how long an unfinished response may hold the process after that. Keep both inside your platform's stop timeout.

## Writes in a deployment

Connections are read-only unless the mounted config says `"writable": true` for one, and the server enforces it whatever the page sends. Leaving it out is the right default for a file a colleague may copy without reading every line. See [Writing](/docs/writing/).

## The image

Built on `node:24-alpine`, pinned, and about 240 MB, nearly all of it Node.js. It runs as an unprivileged user, never root, with `tini` handling signals, so `docker stop` returns at once. The `Dockerfile` and a `docker-compose.yml` are in the [repository](https://github.com/rbaljinder/tablewalk).
