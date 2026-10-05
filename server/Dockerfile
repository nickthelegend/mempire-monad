# Mempire API.
#
# Multi-stage so the shipped image carries production dependencies only — no
# lockfile-resolved dev tree, no build cache, no source control metadata.

# ── deps ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
# Copied on their own so a source edit does not invalidate the dependency layer.
COPY package.json package-lock.json ./
# `npm ci` rather than `install`: it installs exactly the lockfile and fails if
# the two have drifted, which is the behaviour you want in a build that nobody
# is watching.
# `npm install`, not `npm ci`.
#
# `@solana/codecs` — a transitive of spl-token — declares a peer dependency on
# `typescript >= 5`, which npm resolves to the TypeScript 7 platform packages.
# Those land in the tree but not in a lockfile generated with `--omit=dev`, so
# `npm ci` refuses the whole install over a type-checker the server never runs.
# Resolving in the container costs a few seconds and cannot drift.
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Run as a non-root user. The base image ships `node` (uid 1000) for exactly
# this; a container that does not need root should not have it.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node *.js ./
# The seeded coin registries the faucet hands out from, and the deployed AMM
# addresses the TVL reader prices the pool against. Neither is code, so neither
# is caught by the *.js copy above, and the server refuses to start without
# them — a data file added beside a new module is the easy half of the change
# to forget.
#
# Which is exactly what happened: `mainnet-coins.json` was missing from this
# line while `index.js` picks the registry by cluster —
# `readFileSync(isMainnetRpc ? './mainnet-coins.json' : './devnet-coins.json')`.
# Devnet was fine because devnet's file was here; the mainnet image would have
# thrown ENOENT at boot and crash-looped, and the first anyone would have
# learned of it is launch day. BOTH registries ship, always.
COPY --chown=node:node devnet-coins.json mainnet-coins.json amm.json ./

# `wget` is in busybox already, so the healthcheck costs no extra layer.
# Mongo may take a moment on cold start, hence the generous start period.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:${PORT:-8787}/api/health || exit 1

USER node
EXPOSE 8787

# `node` directly, not `npm start`: npm sits between the signal and the process,
# and this server has a SIGTERM handler that closes Mongo cleanly. Exec form so
# there is no shell in between either.
CMD ["node", "index.js"]
