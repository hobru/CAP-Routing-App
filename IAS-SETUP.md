# IAS setup for the MCP Router OAuth flow

After the app is deployed, the bound `identity` service instance
(`mcp-router-identity`) auto-creates an **Application** in your SAP IAS tenant.
The OAuth flow is made to work by configuring that application in the IAS admin
console: `https://<tenant>.accounts.ondemand.com/admin`.

## Identity chain

```
Copilot Studio / MCP client ──OIDC──▶ SAP IAS ──federation──▶ Microsoft Entra ID
        access token (aud = MCP Router client id, email claim)
                    │
                    ▼
        MCP Router (CAP) ── @sap/xssec validates signature/issuer/aud
                    │
                    ▼  principal propagation (email → X.509 → CERTRULE)
        Cloud Connector ──▶ ABAP (SU01 user)
```

## 0. Get the application credentials

The binding writes credentials into `VCAP_SERVICES.identity[0].credentials`.
Retrieve them:

```bash
cf create-service-key mcp-router-identity k1
cf service-key mcp-router-identity k1
# → url (IAS tenant), clientid, clientsecret, certificate/key (x5t), ...
```

`clientid` is the **audience** the inbound token must carry.

## 1. Locate the auto-created application

**Applications & Resources → Applications** → open **"MCP Router"** (the
`display-name` from `mta.yaml`). Everything below is configured on this app.

## 2. Federate authentication to Entra ID

- **Identity Providers → Corporate Identity Providers**: confirm **Microsoft
  Entra ID** is configured (SAML or OIDC) and trusted by the tenant.
- On the MCP Router app → **Conditional Authentication** (or
  *Authentication and Access → Default Identity Provider*): set the default IdP
  to **Entra ID** so users authenticate with their corporate identity.

## 3. Configure the OAuth 2.0 / OIDC client (the caller)

On the app under **Client Authentication** / **Single Sign-On**:

| Setting | Value |
| --- | --- |
| Redirect URIs | The caller's callback. For Copilot Studio / Power Platform connectors this is typically `https://global.consent.azure-apim.net/redirect/<connector>`; for Bot Framework connectors `https://token.botframework.com/.auth/web/redirect`. `mta.yaml` already seeds a `https://global.consent.azure-apim.net/redirect/**` wildcard (so redeploys don't wipe it) — add any tenant-specific URIs here too. |
| Grant types | `authorization_code` + `refresh_token` (interactive SSO). Use `client_credentials` only for non-user/technical calls. |
| Client authentication | Enable **PKCE**, or issue a **client secret** (`clientsecret` above). |
| Authorization / Token endpoints | `<url>/oauth2/authorize` and `<url>/oauth2/token` from the tenant `url`. |

## 4. Audience (most common failure point)

`@sap/xssec` accepts a token only if its **`aud`** matches the MCP Router
`clientid`.

- If the caller uses the **MCP Router's own** client id → audience is correct
  automatically.
- If the caller is a **separate** IAS OAuth client, add the MCP Router
  application as a **trusted/consumed** resource (or request the token with the
  MCP Router as the target audience) so the issued token is audienced to it.

Wrong or empty `aud` → `401 invalid_token`.

## 5. Email claim (required for principal propagation)

The ABAP backend maps the user by e-mail (IAS `mail`/`email` → X.509 →
**CERTRULE** → `SU01`). On the app:

- **Attributes / Assertion Attributes**: ensure **`email`** (and/or `mail`) is
  asserted, sourced from the Entra ID assertion.
- If CERTRULE keys on the subject, set **Subject Name Identifier = e-mail**.
- The asserted value **must equal** the user's `SU01` e-mail on PM4, or the
  X.509 is rejected at the ABAP side (STRUST/CERTRULE) even though the CAP-side
  auth succeeded.

## 6. (Optional) Authorization via groups → roles

The app currently enforces **authentication only** (any validly authenticated
IAS user may call `/mcp`). To also gate on authorization:

1. In IAS, assign users to a **Group** (e.g. `MCP_Users`) — sourced from Entra
   group federation or maintained in IAS.
2. Map the group to the `mcp.User` role, and add an explicit role check in
   `srv/lib/auth.js` after token validation.

Ask if you want this wired in.

## Quick verification after configuration

```bash
# 1. obtain a token (authorization_code via browser, or client_credentials for a test)
# 2. call the router
curl -i https://<app-url>/mcp \
  -H "Authorization: Bearer <token>" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
```

- `401 unauthorized reason=invalid_token` → signature/issuer/**audience** wrong.
- `401 ... reason=missing_bearer_token` → no `Authorization` header.
- `502 destination_error` → token OK, destination/connectivity not resolving.
- `200` / SSE stream → full chain working.

Check `cf logs mcp-router-srv --recent` and correlate by `x-correlation-id`.
