# MCP Router (SAP CAP on BTP)

A lightweight SAP CAP (Node.js) application that routes **MCP (Model Context
Protocol) Streamable HTTP** traffic from a cloud client (e.g. Microsoft Copilot
Studio) to an **on-premise SAP MCP server running on ABAP**, via a **BTP
Destination + SAP Cloud Connector**, with **SAP IAS (federated to Microsoft
Entra ID)** single sign-on and **principal propagation** to the real ABAP user.

It is intentionally small — a reverse proxy with authentication and
troubleshooting logging — modelled on the identity chain of
[`hobru/sap-mcp-gateway-copilot-studio`](https://github.com/hobru/sap-mcp-gateway-copilot-studio),
but **without** the Integration Suite MCP Gateway. That guide series notes the
same identity chain (SAP IAS → Cloud Connector → X.509 → real ABAP user) applies
to *any* BTP service fronting an on-premise backend — this repo is exactly that:
a minimal CAP alternative when you want principal propagation into ABAP without
standing up the full MCP Gateway / Integration Suite. See
[References & videos](#references--videos).

```
Copilot Studio ──HTTPS+Bearer(IAS)──▶ MCP Router (CAP, CF) ──connectivity proxy──▶ Cloud Connector ──X.509──▶ ABAP MCP server
        Entra ID ──▶ IAS (OIDC)                    principal propagation (SAP-Connectivity-Authentication)      CERTRULE: email ▶ SU01 user
```

## Quick start

Four steps from clone to a working SSO call. Details for each are below.

1. **Deploy** to Cloud Foundry (creates the app + destination/connectivity/
   identity/logs services and an IAS application):
   ```bash
   npm install -g mbt        # once
   mbt build                 # → mta_archives/mcp-router_1.0.0.mtar
   cf deploy mta_archives/mcp-router_1.0.0.mtar
   ```
2. **Configure IAS** — federate to Entra ID, set redirect URIs, grant types,
   audience and the `email` claim. See **[`IAS-SETUP.md`](./IAS-SETUP.md)**.
3. **Connect Microsoft Copilot Studio** to `https://<app-url>/mcp` using the IAS
   OAuth client. See [Connect Microsoft Copilot Studio](#connect-microsoft-copilot-studio).
4. **Verify** — list tools from Copilot Studio, or:
   ```bash
   curl https://<app-url>/health           # {"status":"UP"}
   ```

Make sure the BTP **destination** and **Cloud Connector** already exist (see
[Required BTP / backend configuration](#required-btp--backend-configuration)).

## Identity & routing flow

1. Client obtains an **IAS** access token (IAS is federated to **Entra ID**, so
   the user signs in with their corporate identity).
2. Client calls `POST/GET /mcp` on this app with `Authorization: Bearer <token>`.
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
| `srv/server.js` | CAP bootstrap: correlation-id middleware, `/health`, mounts the MCP router before CAP's body parsers (so bodies can stream). |
| `srv/mcp-router.js` | Express router at `/mcp`: auth guard + peeks the JSON-RPC method for logging. |
| `srv/lib/auth.js` | Validates the IAS JWT via `@sap/xssec`; dev fallback via `x-dev-email`. |
| `srv/lib/proxy.js` | Resolves the destination and streams the request through the connectivity proxy (SSE-safe). |
| `mta.yaml` | MTA descriptor (module + destination/connectivity/identity/application-logs). |
| `manifest.yml` | Quick `cf push` alternative. |

## Configuration

Runtime config lives under `cds.mcp` in `package.json`:

```jsonc
"mcp": {
  "destination": "pm4-bp-ssl",        // BTP destination (OnPremise, PrincipalPropagation)
  "backendPath": "/sap/zmcp2/ZMCPX",  // base path of the MCP handler on the ABAP system
  "locationId": "PM4-Sydney",         // SAP Cloud Connector Location ID (must match the SCC)
  "timeout": 120000                   // ms; applied to non-streaming calls only
}
```

Override without editing code (or rebuilding) via env vars, e.g.
`CDS_MCP_DESTINATION`, `CDS_MCP_BACKENDPATH`, `CDS_MCP_LOCATIONID`.
The deploy descriptors (`mta.yaml`, `manifest.yml`) already set
`CDS_MCP_BACKENDPATH` and `CDS_MCP_LOCATIONID`, so you can retarget a running
app with:

```bash
cf set-env mcp-router-srv CDS_MCP_BACKENDPATH /sap/zmcp2/ZMCPX_TEST
cf set-env mcp-router-srv CDS_MCP_LOCATIONID PM4-Sydney
cf restage mcp-router-srv
```

> **Location ID:** OnPremise requests carry a `SAP-Connectivity-SCC-Location_ID`
> header so the connectivity proxy can pick the right Cloud Connector tunnel. It
> **must** match the location the SCC is registered under (case-sensitive). If it
> is empty or wrong you get *"no SAP Cloud Connector (SCC) connected … matching
> the requested tunnel"* — override `CDS_MCP_LOCATIONID` and restage.

### Sub-paths

The `/mcp` route is a catch-all: anything a client appends after `/mcp` is
routed onto `backendPath`. So with the default `backendPath`:

| Client calls (app URL)    | Reaches on ABAP                 |
| ------------------------- | ------------------------------- |
| `/mcp`                    | `/sap/zmcp2/ZMCPX`              |
| `/mcp/ALL`                | `/sap/zmcp2/ZMCPX/ALL`         |
| `/mcp/finance`            | `/sap/zmcp2/ZMCPX/finance`     |
| `/mcp/finance/reports`    | `/sap/zmcp2/ZMCPX/finance/reports` |

The destination's `sap-client` is appended as a query parameter automatically.

> **Note:** `backendPath` defaults to `/sap/zmcp2/ZMCPX` — confirm this matches
> the ICF node the ABAP MCP server is actually published on, and adjust the env
> var if it differs.

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

Target: org `Microsoft_Corporation_mcaps-ai-poc-a5t0we0l`, space `POC`
(subaccount **MCAPS_AI_POC**, region **ap20**).

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

## Connect Microsoft Copilot Studio

Add a custom MCP connector / tool pointing at this app. Use the IAS OAuth client
that the `identity` binding created (get its credentials with
`cf service-key mcp-router-identity k1`).

| Setting | Value |
| --- | --- |
| **Server URL** | `https://<app-url>/mcp` (append sub-paths, e.g. `/mcp/all` → `/sap/zmcp2/ZMCPX/all`) |
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

These are environment steps outside this repo (see the reference project's
guides for detail):

- **Destination `pm4-bp-ssl`** (already present): Type `HTTP`, ProxyType
  `OnPremise`, Authentication `PrincipalPropagation`, URL
  `http://pm4.internal.ssl:44301`, `CloudConnectorLocationId=PM4-Sydney`,
  `sap-client=400`.
- **IAS**: application federated to **Entra ID**; the user's `mail` must match
  the ABAP `SU01` e-mail used by the CERTRULE mapping.
- **Cloud Connector**: system mapping to `pm4.internal.ssl:44301` with CA + system
  certificates for principal propagation.
- **ABAP**: STRUST SSL server PSE, `icm/HTTPS/verify_client=1`,
  `icm/trusted_reverse_proxy_0`, `login/certificate_mapping_rulebased=1`, and a
  **CERTRULE** mapping email → ABAP user.

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

Further reading:

- [SAP API Policy](https://help.sap.com/doc/sap-api-policy/latest/en-US/API_Policy_latest.pdf) — MCP Gateway (Integration Suite) and API Management/Integration Cell are the SAP-endorsed patterns; this CAP router follows the same principal-propagation approach.
- [Model Context Protocol](https://modelcontextprotocol.io/) — the MCP spec (Streamable HTTP transport).
- [SAP Cloud SDK — connectivity](https://sap.github.io/cloud-sdk/) — `getDestination` / on-premise proxy used in `srv/lib/proxy.js`.
