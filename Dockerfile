# syntax=docker/dockerfile:1
#
# tablewalk in a container.
#
# Two properties this file is built around, both of which keep the build's
# tools out of the image that runs:
#
#   - The client is built here, with the server, and served as it was built.
#     `npm run build` bundles it into dist/client with Vite (vite.config.ts,
#     over the installed @mistriwork/kit): minified, content-named, source
#     maps beside it, and a brotli and a gzip copy of every text file, so the
#     runtime copies files and compresses nothing per request.
#   - Only the server is TypeScript, and it is compiled here rather than run
#     through tsx at container start. tsx pulls in esbuild — tens of megabytes
#     of native toolchain — to do at every boot what one build can do once.
#
# The result is a runtime stage holding node and a node_modules laid out as
# `npm install tablewalk` leaves it: this package as `npm pack` ships it, the
# @mistriwork packages it pins and their dependencies (pg among them), all at the
# versions package-lock.json records. Nothing else.

# Node 24 is not a preference, it is a requirement: the SQLite adapter is
# `node:sqlite`, which needs an --experimental-sqlite flag before 23.4 and is
# only a supported built-in from 24. Pinned to an exact patch so a rebuild six
# months from now produces the image that was tested, not the one that is
# current. Bump it deliberately.
ARG NODE_IMAGE=node:24.22.1-alpine3.24

# ---------------------------------------------------------------------------
# Build: compile the server and the page, pack the package, then throw the
# compiler away.
# ---------------------------------------------------------------------------
# On the machine's own platform even for an arm64 image: what it produces (a
# node_modules holding this package's dist/ and the framework's) is plain JavaScript with no native add-on, so the
# runtime stage of either platform takes it as it is, and the compile runs at
# native speed instead of under emulation.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /src

# Manifests first, so editing a source file does not re-run the install. The
# lockfile is copied with it because `npm ci` refuses to run without one, which
# is the point of using ci over install. The @mistriwork packages come from the
# registry at the exact versions package.json pins.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json vite.config.ts LICENSE README.md ./
COPY scripts/build.mjs scripts/bundle-budget.mjs ./scripts/
COPY src ./src
RUN npm run build

# The package as the registry would get it (`files` in package.json), beside
# the production dependencies the lockfile pins: the very versions CI tested,
# not whatever the registry resolves to on the day the image is built (an
# install of the tarball resolved every transitive range afresh, and a rebuild
# six months on could differ from the image that was tested). tsx, typescript,
# vite and esbuild exist to build; the client's libraries are in dist/client's
# bundle. `pg` survives: it is an optional dependency of the engine, not a dev
# one. The tarball is unpacked rather than installed, since an install would
# resolve its ranges again.
RUN mkdir /pack /stage \
 && npm pack --pack-destination /pack --silent \
 && cp /src/package.json /src/package-lock.json /stage/ \
 && cd /stage \
 && npm ci --omit=dev --no-audit --no-fund \
 && mkdir node_modules/tablewalk \
 && tar -xzf /pack/tablewalk-*.tgz -C node_modules/tablewalk --strip-components=1

# The source maps ship in the npm package, for a person debugging an installed
# copy. An image is run, not debugged in place, and they were most of dist/'s
# bytes; a stack trace from one maps against the package of the same version.
RUN find /stage/node_modules/tablewalk /stage/node_modules/@mistriwork -name '*.map' -delete

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# tini is PID 1 so that signals and orphans are handled by something whose job
# that is. The server does install SIGINT/SIGTERM handlers, so Ctrl-C would
# work without this — but a PID 1 with no handler for a signal ignores it
# outright, and that failure mode ("docker stop takes ten seconds then kills
# it") is exactly the one people blame on the application.
RUN apk add --no-cache tini

ENV NODE_ENV=production

# Nothing about any database is in this image. Everything tablewalk browses is
# read at start from files mounted at /config, which means changing it is
# editing a file on the host and restarting — never a rebuild:
#
#   /config/tablewalk.json          connections and views  (connections.ts)
#   /config/tablewalk/layouts.json  record layouts         (layouts.ts)
#   /config/tablewalk/credentials.json   passwords, if you insist on a file
#
# One directory rather than three mount points, because the last two come from
# XDG_CONFIG_HOME, which both modules honour. The first is passed explicitly by
# the entrypoint and overridable with TABLEWALK_CONFIG.
ENV XDG_CONFIG_HOME=/config

# Loopback *inside the container* would mean nothing outside it could ever
# reach the server — the default that is right on a laptop is the one setting
# that cannot work here. The container is the boundary now, so the safety has
# to be re-established at the publish step instead: `-p 127.0.0.1:4111:4111`,
# never `-p 4111:4111`. docs/deploy.md says so in more words.
ENV TABLEWALK_HOST=0.0.0.0

WORKDIR /app
COPY --from=build /stage/node_modules ./node_modules
COPY docker/entrypoint.sh /usr/local/bin/tablewalk-entrypoint

# The node image already ships an unprivileged `node` (uid 1000). /config is
# created and handed to it so that a *named volume* mounted there inherits the
# right owner; a bind mount keeps the host's ownership, which is why docs/deploy.md
# tells you to expect uid 1000. It stays empty in the image — an empty /config
# with no mount is a tablewalk with nothing to browse, which is the correct
# behaviour and says so on startup.
RUN chmod +x /usr/local/bin/tablewalk-entrypoint \
 && mkdir -p /config/tablewalk \
 && chown -R node:node /config
USER node

EXPOSE 4111

# Loopback on purpose: this runs inside the container, and pointing it at the
# published address would test the port mapping rather than the process. GET
# endpoints skip the cross-origin guard, so no Host games are needed. /healthz
# is liveness only (the engine's probes): it answers before any gate and
# opens no database, so a slow or absent database never kills the container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.TABLEWALK_PORT||process.env.PORT||4111)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/tablewalk-entrypoint"]
CMD []
