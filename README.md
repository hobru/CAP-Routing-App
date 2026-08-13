# MCP Router (SAP CAP on BTP)

A lightweight SAP CAP (Node.js) application that routes **MCP (Model Context
Protocol) Streamable HTTP** traffic from a cloud client (e.g. Microsoft Copilot
Studio) to an **on-premise SAP MCP server running on ABAP**, via a **BTP
Destination + SAP Cloud Connector**, with **SAP IAS (federated to Microsoft
Entra ID)** single sign-on and **principal propagation** to the real ABAP user.

It is intentionally small — a reverse proxy with authentication and
troubleshooting logging — modelled on the identity chain of
[`hobru/sap-mcp-gateway-copilot-studio`](https://github.com/hobru/sap-mcp-gateway-copilot-studio),
but without the Integration Suite MCP Gateway.

```
Copilot Studio ──HTTPS+Bearer(IAS)──▶ MCP Router (CAP, CF) ──connectivity proxy──▶ Cloud Connector ──X.509──▶ ABAP MCP server
        Entra ID ──▶ IAS (OIDC)                    principal propagation (SAP-Connectivity-Authentication)      CERTRULE: email ▶ SU01 user
```

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
  "destination": "pm4-bp-ssl",   // BTP destination (OnPremise, PrincipalPropagation)
  "backendPath": "/sap/bc/mcp",  // path of the MCP handler on the ABAP system
  "timeout": 120000              // ms; applied to non-streaming calls only
}
```

Override without editing code via env vars, e.g.
`CDS_MCP_DESTINATION=pm4-bp-ssl`, `CDS_MCP_BACKENDPATH=/sap/bc/mcp`.

> **Note:** `backendPath` (`/sap/bc/mcp`) is a placeholder — set it to the actual
> ICF path the ABAP MCP server is published on.

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
  destination, proxy type, backend status, content type and duration.
- No tokens, secrets or request/response bodies are logged.
- View logs: `cf logs mcp-router-srv --recent` or in Kibana (Application Logs).
