# SaaS connectors

Stripe and Salesforce connectors read through their official APIs with restricted credentials.

## Stripe

Create a Stripe source with `kind="stripe"` and a **restricted key** (`rk_…`) that has read-only access to the objects you sync and to Events. The key is sent as the write-only `secret` and kept in the engine's OS keychain.

```json
{ "name": "Payments", "kind": "stripe",
  "config": { "account_label": "acme-live", "objects": ["customers", "charges", "invoices"], "rate_limit_rps": 25 },
  "secret": "rk_live_..." }
```

- **Objects:** customers, charges, payment_intents, invoices, subscriptions, products, prices, refunds, balance_transactions (all nine by default). Each has fixed columns: `id` as the primary key, `created` as a UTC timestamp, amounts as integers in minor units, nested objects as JSON text, and references such as `customer` as ID strings. Declared relationships link them on the Lineage map.
- **Full refresh:** reads every page of each list endpoint.
- **Incremental** (`mode="incremental"`, with no `watermark_column` and `delete_detection="none"`):
  - Reads `/v1/events` since the last watermark. Updates are merged by `id`, `*.deleted` events remove rows, and the newest event per object wins.
  - `balance_transactions` are append-only, so they're read by `created`.
  - The first run is a full load. If the last sync is more than 29 days old (Stripe keeps events for 30), the run falls back to a full refresh and records the reason.
- **Requests:** at most `rate_limit_rps` per source (25 by default). HTTP 429 and 5xx responses are retried with backoff, honouring `Retry-After`, up to 5 attempts. API keys appear only in the `Authorization` header, never in errors or logs.

## Salesforce

`kind="salesforce"` reads standard and custom objects through the REST describe API and **Bulk API 2.0**.

```json
{ "name": "CRM", "kind": "salesforce",
  "config": { "instance_url": "https://acme.my.salesforce.com", "login_url": "https://login.salesforce.com",
              "client_id": "<connected app consumer key>", "objects": ["Account", "Contact", "Opportunity"] },
  "secret": "<refresh token>" }
```

- **Auth:** OAuth 2.0 refresh token from your own connected app. Use a PKCE public client; no consumer secret is needed. The refresh token lives in the engine keychain, and access tokens are refreshed automatically. A revoked or expired grant fails with "re-authenticate this source". In the desktop app, choose **Sign in with Salesforce**: it runs the PKCE flow in your browser with the callback `http://localhost:1717/OauthRedirect`, which you add to the connected app, and stores the grant on save.
- **Discovery:** one dataset per configured object. Address, location and base64 fields are skipped, because Bulk queries can't return them. A single-target reference field becomes a declared relationship to `Id`.
- **Full refresh:** a Bulk `query` job, paged through `Sforce-Locator`.
- **Incremental** (`mode="incremental"`, with no `watermark_column`):
  - A Bulk `queryAll` job filtered on `SystemModstamp >= <watermark>`. Rows with `IsDeleted = true` are removed from the snapshot.
  - The watermark is the newest `SystemModstamp` seen.
  - If the last sync is older than 14 days, the run falls back to a full refresh, because deleted records leave the recycle bin after 15.
- **Requests:** `rate_limit_rps` defaults to 10 per source.
