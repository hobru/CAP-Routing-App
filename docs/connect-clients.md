# Connect clients (Copilot Studio / Power Automate)

Every route is protected by the same IAS OAuth client (created by the `identity`
binding). Get its credentials with:

```bash
cf service-key mcp-router-identity k1
```

- In **Copilot Studio**, add an MCP connector/tool pointing at an MCP route such
  as `/mcp`.
- In **Power Automate** (or a custom connector), point at the OData or HTTP route
  you configured, such as `/odata` or `/api`.

> Microsoft Copilot Studio and the **SAP OData Connector** increasingly support
> calling SAP OData services directly — this router gives them an IAS-authenticated,
> principal-propagating front door to your on-premise backend.

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

For the full IAS admin-console setup (Entra federation, grant types, audience,
`email` claim), see **[`../IAS-SETUP.md`](../IAS-SETUP.md)**.
