# SAP BTP Router — authenticated proxy to on-premise SAP (CAP on BTP)

A lightweight SAP CAP (Node.js) app that acts as a **generic, authenticated
reverse proxy** from a cloud client (e.g. **Microsoft Copilot Studio**) to your
**on-premise SAP HTTP endpoints on ABAP**, via a **BTP Destination + SAP Cloud
Connector**, with **SAP IAS (federated to Microsoft Entra ID)** single sign-on
and **principal propagation** to the *real ABAP user*.

> [▶️ **Watch the setup walkthrough**](https://youtu.be/xbBXcF79qyY) — deploy the
> router to SAP BTP, configure IAS with Entra ID federation, and verify
> end-to-end principal propagation against an on-premise OData service.

## What is it? Why?

It started life as an **MCP (Model Context Protocol) Streamable HTTP** router —
still a flagship use case — but the proxy itself is **protocol-agnostic**. The
same app fronts:

- **MCP** servers on ABAP (Streamable HTTP + SSE),
- **plain OData services** (`/sap/opu/odata/…`, reads *and* writes), and
- in principle **any on-premise HTTP API** reachable through the Cloud Connector.

This matters because it's not only about MCP: Microsoft **Copilot Studio** and the
**SAP OData Connector** increasingly call SAP OData services directly, and this
router gives them (and any other cloud caller) an IAS-authenticated,
principal-propagating front door to your on-prem backend — with **no technical
service user** in the middle.

### Positioning — relative to the SAP MCP Gateway

This app reuses the identity chain from
**[`hobru/sap-mcp-gateway-copilot-studio`](https://github.com/hobru/sap-mcp-gateway-copilot-studio)**
(SAP IAS → Cloud Connector → X.509 → real ABAP user), but **without** the
Integration Suite MCP Gateway. It's a minimal CAP alternative when you want
principal propagation into ABAP without standing up the full gateway.

**When to use this — and when to reach for the MCP Gateway.** This router is a
great way to get a **first test or pilot** running quickly with minimal moving
parts. It is deliberately **not** as feature-rich as the
[MCP Gateway on SAP Integration Suite](https://github.com/hobru/sap-mcp-gateway-copilot-studio) —
e.g. no built-in rate limiting/throttling, quotas, or API analytics. For many
teams that's fine (throttling/traffic management lives elsewhere). If you need
those *at this hop*, or a productised, policy-governed API surface, use the
Integration Suite MCP Gateway. Sensible path: **pilot with this router, graduate
to the MCP Gateway** when the use case hardens.

```
Copilot Studio ──HTTPS+Bearer(IAS)──▶ BTP Router (CAP, CF) ──connectivity proxy──▶ Cloud Connector ──X.509──▶ ABAP (MCP / OData / HTTP)
        Entra ID ──▶ IAS (OIDC)                    principal propagation (SAP-Connectivity-Authentication)      CERTRULE: email ▶ SU01 user
```

See [**Architecture & how it works**](./docs/architecture.md) for the full
identity/routing flow and project layout.

## Quick start

From clone to a working SSO call. Deep detail is linked from each step.

> **Tools you'll need:** [Node.js](https://nodejs.org/) (18+),
> the [Cloud Foundry CLI](https://docs.cloudfoundry.org/cf-cli/install-go-cli.html)
> with the [MultiApps (MTA) plugin](https://github.com/cloudfoundry/multiapps-cli-plugin#installation)
> (`cf install-plugin multiapps`), and the
> [Cloud MTA Build Tool](https://sap.github.io/cloud-mta-build-tool/) (`mbt`,
> installed in step 3). Log in first with `cf login`.

> **Prerequisite — the BTP destination must already exist.** The app forwards to
> the destination named in `package.json`. Create it in the subaccount **before**
> the first call. For a quick first test you can even start with a **Basic
> authentication** destination and switch to OnPremise + PrincipalPropagation
> later — see [BTP / backend setup](./docs/btp-backend-setup.md).

**1. Clone & install.**

```bash
git clone https://github.com/hobru/CAP-Routing-App.git
cd CAP-Routing-App
npm install
```

**2. Adjust `package.json` (`cds.mcp`).** The committed values are examples from
one environment. Replace them with **your** destination, backend path, and — for
an OnPremise destination — your Cloud Connector Location ID. If the Cloud
Connector uses the default (empty) location, omit `locationId` or set it to `""`:

```json
"mcp": {
  "destination": "<your-destination>",
  "backendPath": "<your-backend-path>",
  "locationId": "<your-scc-location-id>",
  "timeout": 120000,
  "routes": [
    { "path": "/mcp", "peek": true }
  ]
}
```

Need custom paths, several routes, or multiple backends? See
[**Configuration**](./docs/configuration.md).

**3. Build.**

```bash
npm install -g mbt        # once
mbt build                 # → mta_archives/mcp-router_1.0.0.mtar
```

**4. Deploy** to Cloud Foundry ([▶️ video](https://youtu.be/xbBXcF79qyY)) — creates
the app plus destination/connectivity/identity/logs services and an IAS app:

```bash
cf deploy mta_archives/mcp-router_1.0.0.mtar
```

Prefer `cf push`, or want local dev? See [**Deployment**](./docs/deployment.md).

**5. Configure IAS** — federate to Entra ID, set redirect URIs, grant types,
audience and the `email` claim. See **[`IAS-SETUP.md`](./IAS-SETUP.md)**.

**6. Verify.**

```bash
cf app mcp-router-srv
curl https://<route-from-cf>/health     # {"status":"UP"} + build info
curl https://<route-from-cf>/config     # resolved routes → destination + backendPath
```

Then connect a client ([Copilot Studio / Power Automate](./docs/connect-clients.md))
or make the demo call below.

## Try it — call the GWSAMPLE_BASIC OData service

A quick end-user check against the classic SAP demo service. Add an `/odata`
route pointing at the OData base path in `package.json` (`cds.mcp`):

```jsonc
"routes": [
  { "path": "/mcp", "peek": true },
  { "path": "/odata", "backendPath": "/sap/opu/odata/IWBEP" }
]
```

After redeploy, an **authenticated** GET returns sales orders:

```bash
curl -H "Authorization: Bearer <ias-token>" \
  "https://<route-from-cf>/odata/GWSAMPLE_BASIC/SalesOrderSet?\$top=3&\$format=json"
```

The router maps `/odata/GWSAMPLE_BASIC/SalesOrderSet` →
`/sap/opu/odata/IWBEP/GWSAMPLE_BASIC/SalesOrderSet` on the backend, running as the
signed-in ABAP user. Use [`http/verify-router.http`](./http/verify-router.http)
(VS Code REST Client / Postman / Bruno) to fetch an IAS token and run the call.

## Advanced configuration

| Topic | Where |
| --- | --- |
| Custom paths, multiple routes, per-route keys, env overrides | [Configuration](./docs/configuration.md) |
| **Multiple destinations** (one app → many backends) | [Configuration → Multiple destinations](./docs/configuration.md#multiple-destinations) |
| `/health`, `/config` (resolved routes + **build/version**) | [Operations](./docs/operations.md) |
| Disabling `/health` / `/config` (`exposeHealth` / `exposeConfig`) | [Operations → Disabling the diagnostic endpoints](./docs/operations.md#disabling-the-diagnostic-endpoints) |
| Logging, correlation IDs, common error symptoms | [Operations → Logging / Common symptoms](./docs/operations.md#logging) |
| MTA vs `cf push`, local development | [Deployment](./docs/deployment.md) |
| Destination, Cloud Connector, IAS, ABAP (CERTRULE) setup | [BTP / backend setup](./docs/btp-backend-setup.md) |
| Connect Copilot Studio / Power Automate | [Connect clients](./docs/connect-clients.md) |

## Documentation

- [Architecture & how it works](./docs/architecture.md)
- [Configuration](./docs/configuration.md)
- [Deployment](./docs/deployment.md)
- [BTP / backend setup](./docs/btp-backend-setup.md)
- [Operations: health, config & troubleshooting](./docs/operations.md)
- [Connect clients (Copilot Studio / Power Automate)](./docs/connect-clients.md)
- [IAS OAuth setup](./IAS-SETUP.md)

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
| 5 | This CAP router | Deploy on SAP BTP; call MCP, OData, or other HTTP APIs with IAS SSO and principal propagation | [▶️ watch](https://youtu.be/xbBXcF79qyY) |

Further reading:

- [SAP API Policy](https://help.sap.com/doc/sap-api-policy/latest/en-US/API_Policy_latest.pdf) — MCP Gateway (Integration Suite) and API Management/Integration Cell are the SAP-endorsed patterns; this CAP router follows the same principal-propagation approach.
- [Model Context Protocol](https://modelcontextprotocol.io/) — the MCP spec (Streamable HTTP transport).
- [SAP Cloud SDK — connectivity](https://sap.github.io/cloud-sdk/) — `getDestination` / on-premise proxy used in `srv/lib/proxy.js`.
