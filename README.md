# SAP BTP Router (CAP on BTP)

A lightweight SAP CAP (Node.js) application that acts as a **generic
authenticated reverse proxy** from a cloud client (e.g. Microsoft Copilot Studio)
to **on-premise SAP HTTP endpoints running on ABAP**, via a **BTP Destination +
SAP Cloud Connector**, with **SAP IAS (federated to Microsoft Entra ID)** single
sign-on and **principal propagation** to the real ABAP user.

It started life as an **MCP (Model Context Protocol) Streamable HTTP** router —
still its flagship use case — but the proxy itself is protocol-agnostic. The same
app can front:

- **MCP** servers on ABAP (Streamable HTTP + SSE), and
- **generic OData services** (e.g. `/sap/opu/odata/…`, reads *and* writes), and
- in principle **any other on-premise HTTP API** reachable through the Cloud
  Connector.

You can expose **one path or many** — see [Configuration](#configuration) for the
single-route default and the multi-route (`/mcp`, `/odata`, …) setup.

> [▶️ **Watch the setup walkthrough**](https://onedrive.cloud.microsoft/a@r9wv3cr9/_layouts/15/stream.aspx?id=%2Fa%40r9wv3cr9%2FDocuments%2F80%20Events%2FYoutTubeChannel%2F10xDaysOfCode%2FMCP%20Gateway%20on%20BTP%20Integration%20Suite%2F05%20%2D%20Router%20App%20on%20BTP%2Emp4&share=cQowMTJw2B%2D8QJRLod0%5Fa%2DbjEgUCAOOYOEPJSB0oljCpF4S2lQ&referrer=StreamWebApp%2EWeb&referrerScenario=AddressBarCopied%2Eview%2E773a9a08%2D9273%2D4fc1%2D97c6%2De53561f142d5) —
> deploy the router to SAP BTP, configure IAS with Entra ID federation, and
> verify end-to-end principal propagation against an on-premise OData service.

It is intentionally small — a reverse proxy with authentication and
troubleshooting logging — modelled on the identity chain of
[`hobru/sap-mcp-gateway-copilot-studio`](https://github.com/hobru/sap-mcp-gateway-copilot-studio),
but **without** the Integration Suite MCP Gateway. That guide series notes the
same identity chain (SAP IAS → Cloud Connector → X.509 → real ABAP user) applies
to *any* BTP service fronting an on-premise backend — this repo is exactly that:
a minimal CAP alternative when you want principal propagation into ABAP without
standing up the full MCP Gateway / Integration Suite. See
[References & videos](#references--videos).

> **When to use this — and when to reach for the MCP Gateway.** This app is a
> great way to get a **first test or pilot** running quickly: end-to-end SSO and
> principal propagation into ABAP with minimal moving parts. It is deliberately
> **not** as feature-rich as the
> [MCP Gateway on SAP Integration Suite](https://github.com/hobru/sap-mcp-gateway-copilot-studio) —
> for example it has **no built-in rate limiting / throttling, quotas, or API
> analytics**. For many customers that is fine (they already terminate throttling
> and traffic management elsewhere — an API gateway, WAF, or the client platform's
> own limits). If you need those capabilities managed *at this hop*, or a
> productised, policy-governed API surface, use the Integration Suite MCP Gateway
> instead. A sensible path is: **pilot with this router, graduate to the MCP
> Gateway** when the use case hardens.

```
Copilot Studio ──HTTPS+Bearer(IAS)──▶ BTP Router (CAP, CF) ──connectivity proxy──▶ Cloud Connector ──X.509──▶ ABAP (MCP / OData / HTTP)
        Entra ID ──▶ IAS (OIDC)                    principal propagation (SAP-Connectivity-Authentication)      CERTRULE: email ▶ SU01 user
```

## Quick start

Five steps from clone to a working SSO call. Details for each are below.

> **Prerequisite — the BTP destination must already exist.** The app forwards to
> the destination configured in `package.json` (default `pm4-bp-ssl`). Create
> it in the subaccount **before** the first call. For a *quick first test* you can
> even start with a **Basic authentication** destination to a reachable backend
> and switch to OnPremise + PrincipalPropagation later — see
> [Required BTP / backend configuration](#required-btp--backend-configuration).

1. **Configure your target before building.** The values committed in
   `package.json` are examples from one environment. Replace them with **your**
   BTP destination, backend path, and—when using an OnPremise destination—your
   Cloud Connector Location ID:
   ```jsonc
   "mcp": {
     "destination": "<your-destination>",
     "backendPath": "<your-backend-path>",
     "locationId": "<your-scc-location-id>",
     "timeout": 120000,
     "routes": [
       {
         "path": "/mcp",
         "peek": true
       }
     ]
   }
   ```
   Both MTA and `cf push` deployments use these `package.json` values by default.
   If your destination has no Location ID, omit `locationId`. See
   [Configuration](#configuration) for custom or multiple public paths.
2. **Deploy** to Cloud Foundry (creates the app + destination/connectivity/
   identity/logs services and an IAS application):
   ```bash
   npm install -g mbt        # once
   mbt build                 # → mta_archives/mcp-router_1.0.0.mtar
   cf deploy mta_archives/mcp-router_1.0.0.mtar
   ```
3. **Configure IAS** — federate to Entra ID, set redirect URIs, grant types,
   audience and the `email` claim. See **[`IAS-SETUP.md`](./IAS-SETUP.md)**.
4. **Connect Microsoft Copilot Studio or Power Automate** to the appropriate
   configured route using the IAS OAuth client. See
   [Connect Microsoft Copilot Studio or Power Automate to the router](#connect-microsoft-copilot-studio-or-power-automate-to-the-router).
5. **Verify** — get the deployed app URL from the `routes` line printed by:
   ```bash
   cf app mcp-router-srv
   curl https://<route-from-cf>/health     # {"status":"UP"}
   ```
   Then use [`http/verify-router.http`](./http/verify-router.http), Postman, or
   Bruno for an authenticated end-to-end call. See
   [Quick verification after configuration](./IAS-SETUP.md#quick-verification-after-configuration).

Make sure the BTP **destination** and **Cloud Connector** already exist (see
[Required BTP / backend configuration](#required-btp--backend-configuration)).

## Identity & routing flow

1. Client obtains an **IAS** access token (IAS is federated to **Entra ID**, so
   the user signs in with their corporate identity).
2. Client calls one of the app's configured routes (e.g. `POST/GET /mcp`, or `/odata/…` — see [Configuration](#configuration)) on this app with `Authorization: Bearer <token>`.
3. The app **validates the token** (`@sap/xssec`, signature + issuer + audience
   against the bound `identity` service).
4. The app resolves the **`pm4-bp-ssl`** destination *with the user's JWT*
   (`getDestination({ destinationName, jwt })`), which yields a connectivity
   proxy configuration carrying `Proxy-Authorization` and
   `SAP-Connectivity-Authentication` headers for **principal propagation**.
5. The request is streamed through the **connectivity proxy → Cloud Connector**,
   which mints a short-lived **X.509** certificate for the user; the ABAP system
   maps it (via **CERTRULE**, email → `SU01`) to the real backend user.
6. Responses — including **SSE** (`text/event-stream`) — are streamed straight
   back to the client unbuffered.

The inbound IAS bearer is **not** forwarded to the backend; identity flows only
through the connectivity/principal-propagation headers.

## Project layout

| File | Purpose |
| --- | --- |
| `srv/server.js` | CAP bootstrap: correlation-id middleware, `/health`, mounts the router(s) before CAP's body parsers (so bodies can stream). |
| `srv/mcp-router.js` | Mounts one authenticated Express router per configured route (default `/mcp`); auth guard + optional JSON-RPC method peek for logging; forwards all HTTP verbs. |
| `srv/lib/routes.js` | Resolves the route table from config (single-route default or multi-route `cds.mcp.routes` / `CDS_MCP_ROUTES`). |
| `srv/lib/auth.js` | Validates the IAS JWT via `@sap/xssec`; dev fallback via `x-dev-email`. |
| `srv/lib/proxy.js` | Resolves the per-route destination and streams the request through the connectivity proxy (SSE-safe). |
| `http/verify-router.http` | Placeholder-only requests for health, IAS discovery/token exchange, MCP initialization, and an optional OData check. |
| `mta.yaml` | MTA descriptor (module + destination/connectivity/identity/application-logs). |
| `manifest.yml` | Quick `cf push` alternative. |

## Configuration

Runtime config lives under `cds.mcp` in `package.json`. The shipped configuration
uses an explicit `routes` array; the legacy flat configuration without `routes`
remains supported for existing deployments. `mta.yaml` and `manifest.yml` do not
set route-specific values, so a deployment uses the configuration you build.

| What you want | Configuration | Public app path |
| ------------- | ------------- | --------------- |
| Default MCP route | Keep the shipped route entry | Explicitly `/mcp` |
| One route with a custom public path | Edit the shipped route entry | Set `path`, e.g. `/odata` or `/api` |
| Multiple MCP, OData, or other routes | Set `routes` with multiple entries | Each entry has its own `path` |

For every route, anything after the public app path is appended to
`backendPath`. For example, a route with `"path": "/odata"` and
`"backendPath": "/sap/opu/odata/sap"` maps
`/odata/API_BUSINESS_PARTNER/A_BusinessPartner` to
`/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner`.

### Default `/mcp` path

The shipped configuration makes the public path explicit, so changing it does
not require restructuring `package.json`:

```jsonc
"mcp": {
  "destination": "pm4-bp-ssl",        // BTP destination (OnPremise, PrincipalPropagation)
  "backendPath": "/sap/zmcp2/ZMCPX",  // base path of the MCP handler on the ABAP system
  "locationId": "PM4-Sydney",         // SAP Cloud Connector Location ID (must match the SCC)
  "timeout": 120000,                  // ms; applied to non-streaming calls only
  "routes": [
    {
      "path": "/mcp",                 // public app URL prefix
      "peek": true                    // log the JSON-RPC method (MCP only)
    }
  ]
}
```

Edit `path` to change the public prefix, or add more route entries as shown
below. The route inherits `destination`, `backendPath`, `locationId`, and
`timeout` from the top-level values.

Override the shared top-level values without editing code (or rebuilding) via
env vars, e.g. `CDS_MCP_DESTINATION`, `CDS_MCP_BACKENDPATH`,
`CDS_MCP_LOCATIONID`. Set these only when you intentionally want CF runtime
configuration to take precedence over `package.json`, then restage:

```bash
cf set-env mcp-router-srv CDS_MCP_BACKENDPATH /sap/zmcp2/ZMCPX_TEST
cf set-env mcp-router-srv CDS_MCP_LOCATIONID PM4-Sydney
cf restage mcp-router-srv
```

If a deployment still resolves old values, inspect `cf env mcp-router-srv` and
remove stale overrides with `cf unset-env mcp-router-srv <VARIABLE>` before
restaging.

> **Location ID:** OnPremise requests carry a `SAP-Connectivity-SCC-Location_ID`
> header so the connectivity proxy can pick the right Cloud Connector tunnel. It
> **must** match the location the SCC is registered under (case-sensitive). If it
> is empty or wrong you get *"no SAP Cloud Connector (SCC) connected … matching
> the requested tunnel"* — override `CDS_MCP_LOCATIONID` and restage.

#### Appended sub-paths

The `/mcp` route is a catch-all: anything a client appends after `/mcp` is
routed onto `backendPath`. So with the default `backendPath`:

| Client calls (app URL)    | Reaches on ABAP                 |
| ------------------------- | ------------------------------- |
| `/mcp`                    | `/sap/zmcp2/ZMCPX`              |
| `/mcp/ALL`                | `/sap/zmcp2/ZMCPX/ALL`         |
| `/mcp/finance`            | `/sap/zmcp2/ZMCPX/finance`     |
| `/mcp/finance/reports`    | `/sap/zmcp2/ZMCPX/finance/reports` |

The destination's `sap-client` is appended as a query parameter automatically.

> **Note:** the shipped `backendPath` is `/sap/zmcp2/ZMCPX` — confirm this
> matches the backend endpoint and change `package.json` if it differs.

### Custom or multiple paths

To expose **one custom path or several paths** under the same app, edit or extend
the shipped `routes` array. Each route is authenticated and has its own public
`path` and backend `backendPath`. Every route still uses the same IAS SSO +
principal propagation and the same Cloud Connector; only the target path (and,
optionally, destination / verbs / logging) differs.

`path` can be any app URL prefix; `/mcp`, `/odata`, and `/api` are examples, not
a fixed list of allowed values.

```jsonc
"mcp": {
  "destination": "pm4-bp-ssl",     // shared default for every route
  "locationId": "PM4-Sydney",      // shared SCC location (routes fall back to this)
  "timeout": 120000,
  "routes": [
    {
      "path": "/mcp",                       // app URL prefix
      "backendPath": "/sap/zmcp2/ZMCPX",    // ABAP path it maps to
      "peek": true,                          // log the JSON-RPC method (MCP only)
      "methods": ["post", "get", "delete"]  // optional verb allowlist
    },
    {
      "path": "/odata",
      "backendPath": "/sap/opu/odata/IWBEP"  // no `methods` = all verbs (incl. OData MERGE)
    }
  ]
}
```

With that config:

| Client calls (app URL)        | Reaches on ABAP                           |
| ----------------------------- | ----------------------------------------- |
| `/mcp/ALL`                    | `/sap/zmcp2/ZMCPX/ALL`                     |
| `/odata/MY_SRV/$metadata`     | `/sap/opu/odata/IWBEP/MY_SRV/$metadata`    |

Per-route keys:

| Key           | Default                    | Notes                                                                 |
| ------------- | -------------------------- | --------------------------------------------------------------------- |
| `path`        | `/mcp`                     | App URL prefix (leading `/` added if omitted). Catch-all sub-paths.   |
| `backendPath` | top-level `backendPath`    | ABAP base path the prefix maps to.                                    |
| `destination` | top-level `destination`    | Override the BTP destination per route.                               |
| `locationId`  | top-level `locationId`     | Override the SCC Location ID per route.                               |
| `timeout`     | top-level `timeout`        | Non-streaming timeout (ms).                                           |
| `peek`        | `false`                    | Buffer small POST bodies to log the JSON-RPC method. Enable for MCP only. |
| `methods`     | *(all verbs)*              | Lowercase allowlist, e.g. `["post","get","delete"]`. Omit to accept every verb, including OData's `MERGE`. |

**Verbs:** with no `methods` allowlist a route accepts **all** HTTP verbs
(`GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS` and `MERGE`), so OData reads *and* writes
work. Keep `/mcp` restricted to `["post","get","delete"]` (the MCP Streamable HTTP
set) if you don't want it to accept writes.

**OData CSRF:** the proxy forwards request/response headers and cookies generically,
so an OData client's `X-CSRF-Token: Fetch` → replay handshake passes straight through.

**`peek` / memory:** only routes with `peek: true` buffer the request body (bounded
at 256 KB) to log the JSON-RPC method. Leave it off for OData so large `$batch` /
writes stream through without being held in memory.

Override the whole array on a running app without a rebuild via a single JSON env
var (this replaces the `routes` config entirely):

```bash
cf set-env mcp-router-srv CDS_MCP_ROUTES '[{"path":"/mcp","backendPath":"/sap/zmcp2/ZMCPX","peek":true,"methods":["post","get","delete"]},{"path":"/odata","backendPath":"/sap/opu/odata/IWBEP"}]'
cf restage mcp-router-srv
```

If `routes` is absent (or `CDS_MCP_ROUTES` is invalid JSON) the app falls back to
the single `/mcp` route from the flat config — existing deployments are unaffected.


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

## Deploy to Cloud Foundry

Target: your CF **org** and **space** (subaccount region **ap20** in this
example). Set them with `cf target -o <org> -s <space>`.

> **Before you deploy:** make sure the **BTP destination** the app forwards to
> (default `pm4-bp-ssl`, or the value configured in `package.json`) exists in the
> subaccount. Without it, requests fail at the proxy step. See
> [Required BTP / backend configuration](#required-btp--backend-configuration)
> for the destination properties (and a Basic-auth option for a first test).

### Option A — MTA (recommended)

```bash
npm install -g mbt        # if needed
mbt build                 # produces mta_archives/mcp-router_1.0.0.mtar
cf deploy mta_archives/mcp-router_1.0.0.mtar
```

### Option B — cf push

```bash
cf create-service destination      lite        mcp-router-destination
cf create-service connectivity     lite        mcp-router-connectivity
cf create-service identity         application mcp-router-identity
cf create-service application-logs lite        mcp-router-logs
cf push
```

## IAS OAuth setup

After deployment, the `identity` binding auto-creates an **Application** in your
IAS tenant. See **[`IAS-SETUP.md`](./IAS-SETUP.md)** for the step-by-step admin
console configuration (Entra federation, redirect URIs, grant types, token
**audience**, and the **email** claim required for principal propagation).

## Connect Microsoft Copilot Studio or Power Automate to the router

In **Copilot Studio**, add an MCP connector/tool pointing at an MCP route such as
`/mcp`. In **Power Automate**, create a custom connector for the OData or HTTP
route you configured, such as `/odata` or `/api`. Both use the IAS OAuth client
created by the `identity` binding (get its credentials with
`cf service-key mcp-router-identity k1`).

| Setting | Value |
| --- | --- |
| **Route URL** | Run `cf app mcp-router-srv` and prefix the displayed route with `https://`, then append the configured path; for example `/mcp/all` → `/sap/zmcp2/ZMCPX/all` |
| **Auth** | OAuth 2.0 — Authorization Code (+ PKCE / client secret) |
| **Client id / audience** | IAS `clientid` (the token `aud` **must** equal this) |
| **Client secret** | IAS `clientsecret` (or use PKCE) |
| **Authorization URL** | `<ias-url>/oauth2/authorize` |
| **Token URL** | `<ias-url>/oauth2/token` |
| **Redirect URI** | The connector's callback (e.g. `https://global.consent.azure-apim.net/redirect/<connector>`) — add it to the IAS app's redirect URIs |

> **Redirect URIs survive redeploys.** `mta.yaml` seeds the IAS app's
> `redirect-uris` (including a `https://global.consent.azure-apim.net/redirect/**`
> wildcard for Power Platform connectors), so a `cf deploy` no longer wipes
> redirect URIs you add in the IAS console. Add new caller callbacks there to
> keep them permanent.

## Required BTP / backend configuration

These are environment steps **outside this repo**. The identity chain (IAS token
→ Cloud Connector → real ABAP user) is exactly the flow built in the MCP Gateway
series — **[Part 3 (SAP IAS)](https://youtu.be/7Y4TH2DWIoo)** and
**[Part 4 (on-prem principal propagation)](https://youtu.be/x64gVHRdVMQ)** walk
through it end to end.

### Destination (the key piece)

The app resolves the destination named by `CDS_MCP_DESTINATION` and forwards over
the on-premise connectivity proxy. Configure it in the subaccount as **HTTP /
OnPremise / PrincipalPropagation**:

| Property | Value (example) | Notes |
| --- | --- | --- |
| **Type** | `HTTP` | |
| **ProxyType** | `OnPremise` | routes through the Cloud Connector |
| **Authentication** | `PrincipalPropagation` | forwards the *user's* identity, no technical user |
| **URL** | `http://<scc-virtual-host>:<port>` | the **virtual** host defined in the Cloud Connector, not the real ABAP host |
| **CloudConnectorLocationId** | `<scc-location-id>` | must match the SCC's Location ID (case-sensitive; sent as the `SAP-Connectivity-SCC-Location_ID` header) |
| Additional property | `sap-client=<nnn>` | target ABAP client, if required |

> **Why PrincipalPropagation?** Instead of a shared service account, BTP mints a
> short-lived **X.509 certificate** for the logged-in user; the Cloud Connector
> presents it to the ABAP system, which maps it to a real `SU01` user. That means
> ABAP authorizations and audit logs reflect the actual person behind the MCP
> call. Setup (system mapping, CA/system certificates, STRUST, CERTRULE) is
> covered in **[Part 4 ▶️](https://youtu.be/x64gVHRdVMQ)**.

> **First test without principal propagation.** Principal propagation +
> Cloud Connector setup takes time. To validate the router end to end **before**
> that is in place, point `CDS_MCP_DESTINATION` at a simpler destination using
> **Basic authentication** (a technical/service user):
>
> | Property | Value |
> | --- | --- |
> | **Type** | `HTTP` |
> | **ProxyType** | `Internet` (public backend) or `OnPremise` (via Cloud Connector) |
> | **Authentication** | `BasicAuthentication` |
> | **URL** | the backend base URL |
> | **User / Password** | the technical user's credentials |
>
> All calls then run as that single technical user (no per-user identity or
> ABAP-level audit) — fine for a smoke test, **not** for production. Swap to
> `PrincipalPropagation` once the Cloud Connector, certificates and CERTRULE are
> ready; no app change or redeploy is needed, just repoint/reconfigure the
> destination.

### The rest

- **IAS**: application federated to **Entra ID**; the user's `mail` claim must
  match the ABAP `SU01` e-mail used by the CERTRULE mapping. See
  [`IAS-SETUP.md`](./IAS-SETUP.md) and **[Part 3 ▶️](https://youtu.be/7Y4TH2DWIoo)**.
- **Cloud Connector**: a system mapping (virtual host → real ABAP host:port) with
  CA + system certificates enabled for principal propagation, registered under
  the Location ID referenced above. IAS tokens require Cloud Connector **2.13 or
  newer** and explicit trust synchronization:
  1. In the BTP subaccount, confirm the OIDC trust points to the same IAS tenant
     that issues the router token.
  2. In Cloud Connector, open **Cloud To On-Premise → Principal Propagation** and
     choose **Synchronize**.
  3. Select the synchronized IAS identity-provider entry, choose **Edit**, and
     mark it **Trusted**. If the router application is also listed and your
     scenario requires application trust, mark that entry trusted as well.
  4. Enable **Automatic Trust Synchronization** so signing-key rotations do not
     break propagation later.
  5. Under **Configuration → On Premise**, verify that the **CA Certificate**
     used to sign short-lived user certificates is present, valid, and includes
     its private key.
  6. Under **Principal Propagation**, make the subject pattern match claims that
     actually exist in the IAS token. `${name}` prefers `user_name` over
     `email`; therefore, if CERTRULE maps the certificate CN to the user's SU01
     e-mail, use `CN=${email}` rather than `CN=${name}`. Do not use `${mail}`
     unless the token contains a `mail` claim. **Generate Sample Certificate**
     is useful for checking the resulting subject before another request.
- **ABAP**: STRUST SSL server PSE, `icm/HTTPS/verify_client=1`,
  `icm/trusted_reverse_proxy_0`, `login/certificate_mapping_rulebased=1`, and a
  **CERTRULE** mapping email → ABAP user. Detailed in
  **[Part 4 ▶️](https://youtu.be/x64gVHRdVMQ)**.

## Troubleshooting / logging

- Every request carries an `x-correlation-id` (generated or taken from
  `x-request-id` / `x-vcap-request-id`), echoed on the response and in all logs.
- The `mcp` logger records: HTTP method, parsed JSON-RPC method, user email,
  destination, proxy type, resolved **location id**, backend status, content type
  and duration.
- No tokens, secrets or request/response bodies are logged.
- View logs: `cf logs mcp-router-srv --recent` or in Kibana (Application Logs).

### Common symptoms

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `401 … reason=missing_bearer_token` | No `Authorization` header | Caller isn't sending the IAS token |
| `401 … reason=invalid_token` | Wrong signature / issuer / **audience** | Token `aud` must equal the IAS `clientid`; check IAS federation |
| IAS: `redirect_uri … must match` | Redirect URI not on the app (or propagation delay) | Add the exact URI to the IAS app; retry after ~1 min |
| `SSO token validation failed … trust … cloud connector` | Router accepted the IAS token, but the current subaccount's Cloud Connector trust does not include its IAS issuer/application | In SCC, select the **same BTP subaccount as the deployed app** and confirm it is connected; under **Principal Propagation**, choose **Synchronize**, then trust the IAS entry. This rejection can occur before the tunnel, so SCC request logs may remain empty |
| `Unable to generate authorization token for user … on system …` | Cloud Connector trusts the token but cannot create the short-lived X.509 certificate | Check the SCC CA certificate/private key and subject pattern. Use only available token claims; for e-mail-based CERTRULE mapping, prefer `${email}` over `${name}` or `${mail}` |
| `502 … Registered endpoint failed to handle the request` | App crashed / not responding | `cf logs --recent`; check the app booted (`server … launched`) |
| `no SAP Cloud Connector (SCC) connected … matching the requested tunnel` | Location ID empty or mismatched | Set `CDS_MCP_LOCATIONID` to the SCC's location (case-sensitive) and restage |
| `502 connectivity_error` | OnPremise destination without connectivity binding | Ensure `connectivity` + `destination` services are bound |
| Backend `404` | Wrong `backendPath` or case | Override `CDS_MCP_BACKENDPATH`; sub-paths are case-sensitive |

## References & videos

This app reuses the identity chain from the SAP × Copilot Studio MCP Gateway
series — **[`hobru/sap-mcp-gateway-copilot-studio`](https://github.com/hobru/sap-mcp-gateway-copilot-studio)**.
Parts 3–4 are the direct basis for the SSO + principal-propagation flow here.

| # | Guide | Focus | Video |
| --- | --- | --- | --- |
| 1 | [MCP Gateway on SAP Integration Suite](https://github.com/hobru/sap-mcp-gateway-copilot-studio/blob/main/guides/01-integration-suite.md) | Build the MCP server; `client_credentials` via Azure APIM | [▶️ watch](https://youtu.be/1m12OVONavA) |
| 2 | [User auth with Microsoft Entra ID](https://github.com/hobru/sap-mcp-gateway-copilot-studio/blob/main/guides/02-entra-id.md) | OAuth authorization code with Entra ID | [▶️ watch](https://www.youtube.com/watch?v=jE-qlg2vZ6I) |
| 3 | [User auth with SAP IAS (Entra-federated)](https://github.com/hobru/sap-mcp-gateway-copilot-studio/blob/main/guides/03-sap-ias.md) | IAS-issued token — foundation for on-prem propagation | [▶️ watch](https://youtu.be/7Y4TH2DWIoo) |
| 4 | [On-prem principal propagation](https://github.com/hobru/sap-mcp-gateway-copilot-studio/blob/main/guides/04-principal-propagation.md) | Real ABAP user via Cloud Connector + X.509 | [▶️ watch](https://youtu.be/x64gVHRdVMQ) |
| 5 | [Lightweight router app on SAP BTP](#quick-start) | Deploy this CAP router; call MCP, OData, or other HTTP APIs with IAS SSO and principal propagation | [▶️ watch](https://onedrive.cloud.microsoft/a@r9wv3cr9/_layouts/15/stream.aspx?id=%2Fa%40r9wv3cr9%2FDocuments%2F80%20Events%2FYoutTubeChannel%2F10xDaysOfCode%2FMCP%20Gateway%20on%20BTP%20Integration%20Suite%2F05%20%2D%20Router%20App%20on%20BTP%2Emp4&share=cQowMTJw2B%2D8QJRLod0%5Fa%2DbjEgUCAOOYOEPJSB0oljCpF4S2lQ&referrer=StreamWebApp%2EWeb&referrerScenario=AddressBarCopied%2Eview%2E773a9a08%2D9273%2D4fc1%2D97c6%2De53561f142d5) |

Further reading:

- [SAP API Policy](https://help.sap.com/doc/sap-api-policy/latest/en-US/API_Policy_latest.pdf) — MCP Gateway (Integration Suite) and API Management/Integration Cell are the SAP-endorsed patterns; this CAP router follows the same principal-propagation approach.
- [Model Context Protocol](https://modelcontextprotocol.io/) — the MCP spec (Streamable HTTP transport).
- [SAP Cloud SDK — connectivity](https://sap.github.io/cloud-sdk/) — `getDestination` / on-premise proxy used in `srv/lib/proxy.js`.
