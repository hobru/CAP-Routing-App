# Deployment

Two deploy paths ship with the app: an **MTA** build (recommended) and a quick
`cf push`. Both use the `cds.mcp` config from `package.json` — see
[Configuration](./configuration.md).

Target your CF **org** and **space** first (subaccount region **ap20** in this
example):

```bash
cf target -o <org> -s <space>
```

> **Before you deploy:** make sure the **BTP destination** the app forwards to
> (default `pm4-bp-ssl`, or the value configured in `package.json`) exists in the
> subaccount. Without it, requests fail at the proxy step. See
> [BTP / backend setup](./btp-backend-setup.md) for the destination properties
> (and a Basic-auth option for a first test).

## Option A — MTA (recommended)

```bash
npm install -g mbt        # if needed
mbt build                 # produces mta_archives/mcp-router_1.0.0.mtar
cf deploy mta_archives/mcp-router_1.0.0.mtar
```

The MTA build captures the git commit/branch automatically, so `/config` and
`/health` report an accurate build stamp (see
[Operations](./operations.md#inspecting-the-live-configuration)).

## Option B — cf push

```bash
cf create-service destination      lite        mcp-router-destination
cf create-service connectivity     lite        mcp-router-connectivity
cf create-service identity         application mcp-router-identity
cf create-service application-logs lite        mcp-router-logs
cf push
```

> On a plain `cf push` the buildpack does not upload `.git`, so the build stamp's
> `commit`/`buildTime` may be empty. Set `GIT_COMMIT` / `BUILD_TIME` in
> `manifest.yml` env, or use the MTA path (which captures git automatically).

## IAS OAuth setup

After deployment, the `identity` binding auto-creates an **Application** in your
IAS tenant. See **[`../IAS-SETUP.md`](../IAS-SETUP.md)** for the step-by-step admin
console configuration (Entra federation, redirect URIs, grant types, token
**audience**, and the **email** claim required for principal propagation).

## Local development

```bash
npm install
npm run watch      # or: npx cds serve
```

- Auth uses the **mocked** kind; requests to `/mcp` without a token are accepted
  and a mock principal is taken from the `x-dev-email` header.
- Without a `destination`/`connectivity` binding the proxy returns a clean
  `502 destination_error` — expected locally.

```bash
curl http://localhost:4004/health
curl -X POST http://localhost:4004/mcp -H 'content-type: application/json' \
     -H 'x-dev-email: me@corp.com' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
```
