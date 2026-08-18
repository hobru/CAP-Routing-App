# Architecture & how it works

The router is a small CAP (Node.js) reverse proxy. It authenticates the caller
with an **IAS** token (IAS federated to **Entra ID**), then streams the request
through the **SAP connectivity proxy → Cloud Connector** to an on-premise SAP
system, propagating the **real ABAP user**.

```
Copilot Studio ──HTTPS+Bearer(IAS)──▶ BTP Router (CAP, CF) ──connectivity proxy──▶ Cloud Connector ──X.509──▶ ABAP (MCP / OData / HTTP)
        Entra ID ──▶ IAS (OIDC)                    principal propagation (SAP-Connectivity-Authentication)      CERTRULE: email ▶ SU01 user
```

## Identity & routing flow

1. Client obtains an **IAS** access token (IAS is federated to **Entra ID**, so
   the user signs in with their corporate identity).
2. Client calls one of the app's configured routes (e.g. `POST/GET /mcp`, or
   `/odata/…` — see [Configuration](./configuration.md)) with
   `Authorization: Bearer <ias-token>`.
3. The app **validates the token** (`@sap/xssec`, signature + issuer + audience
   against the bound `identity` service).
4. The app resolves the route's **destination** *with the user's JWT*
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
| `srv/server.js` | CAP bootstrap: correlation-id middleware, `/health`, `/config`, mounts the router(s) before CAP's body parsers (so bodies can stream). |
| `srv/mcp-router.js` | Mounts one authenticated Express router per configured route (default `/mcp`); auth guard + optional JSON-RPC method peek for logging; forwards all HTTP verbs. |
| `srv/lib/routes.js` | Resolves the route table from config: grouped `cds.mcp.destinations` / `CDS_MCP_DESTINATIONS`, multi-route `cds.mcp.routes` / `CDS_MCP_ROUTES`, or the single-route default. Also exposes the safe view behind `/config`. |
| `srv/lib/auth.js` | Validates the IAS JWT via `@sap/xssec`; dev fallback via `x-dev-email`. |
| `srv/lib/proxy.js` | Resolves the per-route destination and streams the request through the connectivity proxy (SSE-safe). |
| `srv/lib/build-info.js` | Best-effort build/version metadata (from `build-info.json` + fallbacks) surfaced by `/config` and `/health`. |
| `scripts/gen-build-info.js` | Stamps `build-info.json` (version, build time, git commit) at build time; run by the `build` + `postinstall` npm scripts. |
| `http/verify-router.http` | Placeholder-only requests for health, IAS discovery/token exchange, MCP initialization, and an optional OData check. |
| `mta.yaml` | MTA descriptor (module + destination/connectivity/identity/application-logs). |
| `manifest.yml` | Quick `cf push` alternative. |
