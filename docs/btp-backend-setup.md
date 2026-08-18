# BTP / backend setup

These are environment steps **outside this repo**. The identity chain (IAS token
→ Cloud Connector → real ABAP user) is exactly the flow built in the MCP Gateway
series — **[Part 3 (SAP IAS)](https://youtu.be/7Y4TH2DWIoo)** and
**[Part 4 (on-prem principal propagation)](https://youtu.be/x64gVHRdVMQ)** walk
through it end to end.

## Destination (the key piece)

The app resolves the destination named by `CDS_MCP_DESTINATION` (or `package.json`)
and forwards over the on-premise connectivity proxy. Configure it in the
subaccount as **HTTP / OnPremise / PrincipalPropagation**:

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
> ABAP authorizations and audit logs reflect the actual person behind the call.
> Setup (system mapping, CA/system certificates, STRUST, CERTRULE) is covered in
> **[Part 4 ▶️](https://youtu.be/x64gVHRdVMQ)**.

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

## The rest

- **IAS**: application federated to **Entra ID**; the user's `mail` claim must
  match the ABAP `SU01` e-mail used by the CERTRULE mapping. See
  [`../IAS-SETUP.md`](../IAS-SETUP.md) and **[Part 3 ▶️](https://youtu.be/7Y4TH2DWIoo)**.
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
