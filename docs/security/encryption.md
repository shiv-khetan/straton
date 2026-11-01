# Encryption, audit and supply chain

How data at rest, the audit trail and releases are protected.

## Encryption at rest

New Parquet snapshots and staging parts are encrypted by default with Parquet modular AES-GCM encryption, including every column and the footer. Each dataset/model output has a 256-bit data key, stored AES-256-GCM wrapped in state.db. The wrapping KEK resides only in the OS keychain (service straton, account kek). Local lake aliases share their physical snapshot's encryption. Each snapshot's durable _key sidecar selects its key; retain it with the parts.

Configure [encryption] enabled = false in straton.toml or STRATON_ENCRYPTION_ENABLED=false to make new runs plaintext. Encrypted snapshots remain readable with the KEK; legacy plaintext snapshots remain readable without a sidecar. Resumed staging retains its original encryption choice. Missing keys and failed unwraps deny encrypted reads.

Administrators manage keys in **Admin → Security & Backups** or with GET /v1/admin/keys, POST /v1/admin/keys/rotate-kek, and POST /v1/admin/keys/rotate/<dataset-id>. KEK rotation re-wraps existing keys without rewriting data, using a pending keychain entry for crash recovery. Dataset rotation requires its active runs to finish, retires its key, and uses a new key on the next run. Cleanup deletes retired keys only after their snapshots/checkpoints are gone. Key metadata APIs never return key material.

**state.db and database backups deliberately stay plaintext**: they contain metadata, model definitions, token hashes, wrapped keys, and audit rows. Secrets live in the keychain. Protect metadata/backups with OS permissions; SQLCipher and mTLS are deferred. Database backups exclude Parquet and keychain secrets. An old backup may require its old KEK version after rotation; plan protected keychain recovery alongside database recovery. See [Security policy](../security/index.md) for the exact boundary.

## Audit log integrity

Audit rows form a SHA-256 chain over the previous hex hash and canonical JSON of the row's id, timestamp (at), action, entity_id, principal_id, and detail. Existing rows are backfilled once at migration. The head lookup and insertion share the caller's SQLite write transaction. Append-only triggers remain enforced.

Administrators can use **Verify audit chain**, GET /v1/audit/verify, or run **straton-engine verify-audit** while the engine is stopped. Verification returns {ok, rows, first_bad_id}; CLI failure produces a nonzero exit. /v1/status includes audit_head for external anchoring. Store heads in an independently trusted system: someone who can rewrite the entire database can also recompute the chain or truncate a valid suffix.

## Supply chain

CI runs Rust fmt/clippy/tests, cargo-deny, desktop formatting/build/tests, and npm audit --audit-level=high. deny.toml uses the binding license allowlist, crates.io-only sources, and duplicate-version warnings. Its only additional license permission is scoped to tiny-keccak 2.0.2 (CC0-1.0), found by inspecting all 487 locked registry manifests offline.

Tagged releases build through cargo-auditable and attach per-crate CycloneDX SBOMs, SHA-256 checksums, and keyless cosign signature bundles. Verify the expected repository, tag, and CI workflow identity before trusting checksums or SBOMs; commands and reporting instructions are in [Security policy](../security/index.md).
