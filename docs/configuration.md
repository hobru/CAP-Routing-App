# Configuration

Runtime config lives under `cds.mcp` in `package.json`. The shipped configuration
uses an explicit `routes` array; the legacy flat configuration without `routes`
remains supported for existing deployments. `mta.yaml` and `manifest.yml` do not
set route-specific values, so a deployment uses the configuration you build.

| What you want | Configuration | Public app path |
| ------------- | ------------- | --------------- |
| Default MCP route | Keep the shipped route entry | Explicitly `/mcp` |
| One route with a custom public path | Edit the shipped route entry | Set `path`, e.g. `/odata` or `/api` |
| Multiple MCP, OData, or other routes | Set `routes` with multiple entries | Each entry has its own `path` |
| Multiple backend systems | Use grouped [`destinations`](#multiple-destinations) | Each group binds one destination |

For every route, anything after the public app path is appended to
`backendPath`. For example, a route with `"path": "/odata"` and
`"backendPath": "/sap/opu/odata/sap"` maps
`/odata/API_BUSINESS_PARTNER/A_BusinessPartner` to
`/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner`.

## Default `/mcp` path

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
> the requested tunnel"* — override `CDS_MCP_LOCATIONID` and restage. If the
> Cloud Connector is registered under the **default (empty)** location, set
> `locationId` to `""` (see the per-route table below).

### Appended sub-paths

The `/mcp` route is a catch-all: anything a client appends after `/mcp` is
routed onto `backendPath`. So with the default `backendPath`:

| Client calls (app URL)    | Reaches on ABAP                 |
| ------------------------- | ------------------------------- |
| `/mcp`                    | `/sap/zmcp2/ZMCPX`              |
| `/mcp/ALL`                | `/sap/zmcp2/ZMCPX/ALL`         |
| `/mcp/finance`            | `/sap/zmcp2/ZMCPX/finance`     |
| `/mcp/finance/reports`    | `/sap/zmcp2/ZMCPX/finance/reports` |

The destination's `sap-client` is appended as a query parameter automatically.

## Custom or multiple paths

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

### Per-route keys

| Key           | Default                    | Notes                                                                 |
| ------------- | -------------------------- | --------------------------------------------------------------------- |
| `path`        | `/mcp`                     | App URL prefix (leading `/` added if omitted). Catch-all sub-paths.   |
| `backendPath` | top-level `backendPath`    | ABAP base path the prefix maps to.                                    |
| `destination` | top-level `destination`    | Override the BTP destination per route.                               |
| `locationId`  | top-level `locationId`     | Override the SCC Location ID per route. Set to `""` for a destination whose Cloud Connector uses the **default (empty)** location — the empty value is honoured and won't inherit the top-level default. |
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

## Multiple destinations

The per-route `destination` key already lets individual routes target different
BTP destinations. When you proxy to **more than one backend system**, the
grouped `destinations` shape is clearer: each entry binds **one** BTP
destination and can expose **many** routes, each with its own public `path` and
backend `backendPath`. A destination group's `name`, `locationId`, `timeout`,
and `backendPath` become the defaults for all of its routes (a route can still
override any of them).

```jsonc
"mcp": {
  "timeout": 120000,                 // global default for every route
  "destinations": [
    {
      "name": "pm4-bp-ssl",          // BTP destination #1 (OnPremise, PrincipalPropagation)
      "locationId": "PM4-Sydney",    // SCC location shared by this group's routes
      "routes": [
        {
          "path": "/mcp",                        // → pm4-bp-ssl /sap/zmcp2/ZMCPX
          "backendPath": "/sap/zmcp2/ZMCPX",
          "peek": true,
          "methods": ["post", "get", "delete"]
        },
        {
          "path": "/odata",                       // → pm4-bp-ssl /sap/opu/odata/IWBEP
          "backendPath": "/sap/opu/odata/IWBEP"
        }
      ]
    },
    {
      "name": "other-backend",       // BTP destination #2 (its own SCC tunnel)
      "locationId": "PM4-Tokyo",
      "routes": [
        { "path": "/api2", "backendPath": "/sap/zsvc/ZOTHER" }   // → other-backend /sap/zsvc/ZOTHER
      ]
    }
  ]
}
```

Every route across all destinations still shares the same IAS SSO + principal
propagation; only the target destination and path differ. The route table above
resolves to:

| Client calls (app URL)     | Destination     | Reaches on ABAP                        |
| -------------------------- | --------------- | -------------------------------------- |
| `/mcp/ALL`                 | `pm4-bp-ssl`    | `/sap/zmcp2/ZMCPX/ALL`                 |
| `/odata/MY_SRV/$metadata`  | `pm4-bp-ssl`    | `/sap/opu/odata/IWBEP/MY_SRV/$metadata`|
| `/api2/foo`                | `other-backend` | `/sap/zsvc/ZOTHER/foo`                 |

Destination group keys: `name` (the BTP destination), `routes` (its routes),
and optional `backendPath` / `locationId` / `timeout` defaults inherited by
those routes. Per-route keys are the same as the [table above](#per-route-keys).

Grouped `destinations` and a top-level `routes` array can coexist; grouped
routes are resolved first. If two entries declare the **same** public `path`,
the first one wins and the duplicate is ignored (logged as a warning) so a
stray leftover can't double-mount a path. Ensure each backend destination
exists in the subaccount — see
[BTP / backend setup](./btp-backend-setup.md).

Override the whole set on a running app without a rebuild via a single JSON env
var (this replaces the `destinations` config entirely):

```bash
cf set-env mcp-router-srv CDS_MCP_DESTINATIONS '[{"name":"pm4-bp-ssl","locationId":"PM4-Sydney","routes":[{"path":"/mcp","backendPath":"/sap/zmcp2/ZMCPX","peek":true,"methods":["post","get","delete"]},{"path":"/odata","backendPath":"/sap/opu/odata/IWBEP"}]},{"name":"other-backend","locationId":"PM4-Tokyo","routes":[{"path":"/api2","backendPath":"/sap/zsvc/ZOTHER"}]}]'
cf restage mcp-router-srv
```

## Diagnostic endpoint flags

The unauthenticated `GET /health` and `GET /config` endpoints are exposed by
default. Each can be turned off independently under the top-level `cds.mcp`
config — useful when you don't want `/config` to reveal routing identifiers
(destinations, backend paths, location ids) in production:

> **Top-level only.** `/health` and `/config` are single, app-wide endpoints,
> so these two flags live at the top of `cds.mcp` (siblings of `destination` /
> `destinations` / `routes`). Placing them *inside* a `destinations[]` entry has
> no effect — there is no per-destination health or config endpoint.

| Key            | Default | Notes                                                                 |
| -------------- | ------- | --------------------------------------------------------------------- |
| `exposeHealth` | `true`  | Set `false` to hide `GET /health` (returns `404`). **Also switch the CF `health-check-type` to `process`/`port`** — see [Operations](./operations.md#disabling-the-diagnostic-endpoints). |
| `exposeConfig` | `true`  | Set `false` to hide `GET /config` (returns `404`).                    |

```json
"mcp": {
  "exposeConfig": false
}
```

Both accept a runtime override too (`CDS_MCP_EXPOSEHEALTH` /
`CDS_MCP_EXPOSECONFIG`, e.g. `false`), so you can flip them with `cf set-env`
+ `cf restage` without rebuilding. Full details, including the health-check
caveat, are in
[Operations → Disabling the diagnostic endpoints](./operations.md#disabling-the-diagnostic-endpoints).

## Verify what the app actually loaded

Use the unauthenticated **`GET /config`** endpoint to see the *resolved* route
table (including env overrides) and the live build/version. See
[Operations → Inspecting the live configuration](./operations.md#inspecting-the-live-configuration).
