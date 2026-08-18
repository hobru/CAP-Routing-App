# Operations: health, config & troubleshooting

The router exposes two **unauthenticated** endpoints to make a deployment easy to
inspect, plus structured logging for every proxied request. Both are enabled by
default and can be switched off individually — see
[Disabling the diagnostic endpoints](#disabling-the-diagnostic-endpoints).

## `GET /health`

Liveness check used by the CF health monitor. Returns `{"status":"UP"}` plus the
live `build` block (see below).

```bash
curl https://<route-from-cf>/health
```

> **Health check dependency.** `manifest.yml` configures `cf push` to probe this
> endpoint (`health-check-type: http`, `health-check-http-endpoint: /health`). If
> you disable `/health` (see below), also switch `health-check-type` to `process`
> (or `port`) or the app will never report healthy and the deploy will fail. The
> MTA deploy path (`mta.yaml`) uses a `port` check and is unaffected.

## Inspecting the live configuration

Working out which destination and backend path each public path maps to should
not mean cross-referencing User-Provided Variables in the BTP cockpit. The
**`GET /config`** endpoint returns the router's *resolved* route table so you can
see it directly from a browser or `curl`:

```bash
curl https://<route-from-cf>/config
```

```jsonc
{
  "service": "mcp-router",
  "build": {
    "name": "mcp-router",
    "version": "1.0.0",
    "buildTime": "2026-08-18T06:52:06.154Z",   // when the deployed artifact was built
    "commit": "03f2c6ef…",                       // git commit the build was cut from
    "commitShort": "03f2c6e",
    "branch": "hobru-multi-destination-config",
    "repo": "https://github.com/hobru/CAP-Routing-App",            // browsable remote (no .git)
    "branchUrl": "https://github.com/hobru/CAP-Routing-App/tree/hobru-multi-destination-config",
    "commitUrl": "https://github.com/hobru/CAP-Routing-App/commit/03f2c6ef…",
    "nodeVersion": "v20.x",
    "stamped": true,                             // false ⇒ no build stamp, values are fallbacks
    "startedAt": "2026-08-18T06:52:29.464Z"      // when this app instance started
  },
  "profiles": ["production"],
  "endpoints": { "health": true, "config": true },
  "ts": "…",
  "routes": [
    { "path": "/mcp",   "destination": "pm4-bp-ssl",    "backendPath": "/sap/zmcp2/ZMCPX",     "locationId": "PM4-Sydney", "methods": ["post","get","delete"], "peek": true },
    { "path": "/odata", "destination": "pm4-bp-ssl",    "backendPath": "/sap/opu/odata/IWBEP", "locationId": "PM4-Sydney", "methods": "all",                    "peek": false },
    { "path": "/api2",  "destination": "other-backend", "backendPath": "/sap/zsvc/ZOTHER",     "locationId": "PM4-Tokyo",  "methods": "all",                    "peek": false }
  ]
}
```

The route table reflects whatever the app actually loaded — including any
`CDS_MCP_DESTINATIONS` / `CDS_MCP_ROUTES` / `CDS_MCP_*` env overrides — so it is
the quickest way to confirm a deployment picked up the config you expect. It
exposes only configuration identifiers (destination names, public paths, backend
paths, SCC location ids); it never returns tokens, credentials, or the backend
host URL (that lives in the BTP destination and is resolved per request with the
caller's JWT).

### The `build` block — which version is live?

The `build` block tells you **which** build is live, so you can confirm a
redeploy actually took effect rather than guessing from the route table alone.
`version` comes from `package.json`; `buildTime`/`commit`/`branch`/`repo` are stamped
into `build-info.json` at build time (by `scripts/gen-build-info.js`, wired into
the `build` and `postinstall` npm scripts, so `mbt build` and buildpack staging
both stamp it). `repo` is derived from the `origin` remote (scp and `.git` forms
are normalized to an `https://…` base); when it and the branch/commit are known,
the app also derives clickable `branchUrl` / `commitUrl`. If no stamp is present,
`stamped` is `false` and the fields fall back to `package.json` + the
`BUILD_TIME` / `GIT_COMMIT` / `GIT_BRANCH` / `GIT_REPO_URL` env vars.
`startedAt` is always the current instance's start time. The same `build` block
is included in **`GET /health`**.

## Disabling the diagnostic endpoints

Both endpoints are exposed by default. Because `/config` reveals routing
identifiers (destination names, backend paths, SCC location ids), you may want to
hide it in production. Each endpoint has its own flag at the **top level** of
`cds.mcp` in `package.json` (both default to `true`; they are app-wide, so they
do **not** go inside a `destinations[]` entry):

```json
"mcp": {
  "exposeHealth": true,
  "exposeConfig": false
}
```

A disabled endpoint simply isn't registered, so it returns `404`. You can also
flip either flag at runtime without redeploying the artifact, via a
User-Provided Variable / env override:

```bash
cf set-env mcp-router-srv CDS_MCP_EXPOSECONFIG false && cf restage mcp-router-srv
```

The `endpoints` block in the `/config` response reflects the current state, so
you can confirm what is exposed while `/config` is still on.

> **If you disable `/health`,** update the CF health check in `manifest.yml`:
> change `health-check-type` from `http` to `process` (or `port`) and remove the
> `health-check-http-endpoint` line. Otherwise the platform keeps probing a route
> that now returns `404` and the app never becomes healthy. The MTA path
> (`mta.yaml`) uses a `port` check and needs no change.

## Logging

- Every request carries an `x-correlation-id` (generated or taken from
  `x-request-id` / `x-vcap-request-id`), echoed on the response and in all logs.
- The `mcp` logger records: HTTP method, parsed JSON-RPC method, user email,
  destination, proxy type, resolved **location id**, backend status, content type
  and duration.
- No tokens, secrets or request/response bodies are logged.
- View logs: `cf logs mcp-router-srv --recent` or in Kibana (Application Logs).

## Common symptoms

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `401 … reason=missing_bearer_token` | No `Authorization` header | Caller isn't sending the IAS token |
| `401 … reason=invalid_token` | Wrong signature / issuer / **audience** | Token `aud` must equal the IAS `clientid`; check IAS federation |
| IAS: `redirect_uri … must match` | Redirect URI not on the app (or propagation delay) | Add the exact URI to the IAS app; retry after ~1 min |
| `SSO token validation failed … trust … cloud connector` | Router accepted the IAS token, but the current subaccount's Cloud Connector trust does not include its IAS issuer/application | In SCC, select the **same BTP subaccount as the deployed app** and confirm it is connected; under **Principal Propagation**, choose **Synchronize**, then trust the IAS entry. This rejection can occur before the tunnel, so SCC request logs may remain empty |
| `Unable to generate authorization token for user … on system …` | Cloud Connector trusts the token but cannot create the short-lived X.509 certificate | Check the SCC CA certificate/private key and subject pattern. Use only available token claims; for e-mail-based CERTRULE mapping, prefer `${email}` over `${name}` or `${mail}` |
| `502 … Registered endpoint failed to handle the request` | App crashed / not responding | `cf logs --recent`; check the app booted (`server … launched`) |
| `Access denied to system … expose the system correctly in your cloud connector` / `no SAP Cloud Connector (SCC) connected … matching the requested tunnel` | Location ID empty, mismatched, or wrongly defaulted | Set the route's `locationId` to the SCC's location (case-sensitive), or `""` for the **default (empty)** location; restage |
| `502 connectivity_error` | OnPremise destination without connectivity binding | Ensure `connectivity` + `destination` services are bound |
| Backend `404` | Wrong `backendPath` or case | Override `CDS_MCP_BACKENDPATH`; sub-paths are case-sensitive |
