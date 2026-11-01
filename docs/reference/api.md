# HTTP API

All routes live under `/v1` on the engine's REST bind (`127.0.0.1:8787` by default).
`GET /health` is public; **every other route requires** `Authorization: Bearer <token>`,
including WebSocket upgrades. Unauthenticated requests get `401` with
`{"error":"invalid bearer token"}` before any input is parsed.

Request bodies reject unknown fields. Errors are JSON objects with an `error` string; failed
validation also returns field-level details. Secrets are write-only: no response ever contains
a connector secret, token or token hash.

!!! info "Generated from the code"
    This table is built from the engine's authentication contract test, which fails when a
    route is registered without being listed. It is always complete.

<!-- api-routes -->
