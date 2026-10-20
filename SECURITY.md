# Security policy

## Reporting

Report vulnerabilities privately through the repository's GitHub **Security → Report a vulnerability** form. Include the affected version, configuration, reproduction steps, and impact. Do not include production data, credentials, encryption keys, or live tokens. If private reporting is unavailable, contact the repository maintainers privately to arrange a secure channel; do not open a public issue with exploit details.

## Supported versions

Security fixes target the latest 0.1.x release and the main development branch. Earlier pre-release builds are unsupported; upgrade before reporting a problem that has already been fixed.

## Verifying releases

A tagged release includes an auditable Linux engine binary, a CycloneDX JSON SBOM for each workspace crate, SHA256SUMS, and a Sigstore bundle for every artifact, including SHA256SUMS. Install cosign through its official distribution, then obtain the assets from the intended repository's Releases page.

Set REPOSITORY to the exact GitHub owner/repository and TAG to the expected release tag. Verify the checksum manifest's signature before trusting its checksums:

    REPOSITORY=OWNER/Straton
    TAG=v0.1.0
    cosign verify-blob --bundle SHA256SUMS.sigstore.json --certificate-identity "https://github.com/$REPOSITORY/.github/workflows/ci.yml@refs/tags/$TAG" --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS
    sha256sum --check SHA256SUMS
    cosign verify-blob --bundle straton-engine.cdx.json.sigstore.json --certificate-identity "https://github.com/$REPOSITORY/.github/workflows/ci.yml@refs/tags/$TAG" --certificate-oidc-issuer https://token.actions.githubusercontent.com straton-engine.cdx.json

Use the same verification command for the binary and other SBOMs, substituting their exact asset and bundle filenames. Do not accept an arbitrary certificate identity or disable transparency-log verification. Inspect the SBOM's components and versions with a CycloneDX-compatible viewer. The binary embeds dependency metadata through cargo-auditable; signatures attest to the publishing workflow, not the absence of vulnerabilities.

## Encryption boundary and key recovery

New snapshot and staging Parquet files use modular encryption with AES-GCM: the footer and every column share a dataset-specific 256-bit DEK. Local lake aliases reference the same encrypted physical snapshot. Model outputs have their own DEKs. Only wrapped DEKs are stored in state.db; wrapping uses ring AES-256-GCM with a fresh nonce and authenticated key/target identifiers. The KEK lives in the OS keychain under service straton, account kek. Key material is never returned through the API or written to logs.

[encryption] enabled defaults to true; STRATON_ENCRYPTION_ENABLED overrides it. Disabling encryption affects new runs only. Existing encrypted snapshots still require their keys; legacy snapshots without a _key sidecar remain readable. A recovered staging directory keeps its recorded key choice. A missing or invalid keychain KEK, unknown key id, or failed unwrap denies encrypted reads. Keep _key sidecars together with their snapshot directories.

**state.db and its database backups deliberately remain plaintext.** They contain catalog/configuration metadata, model SQL, token hashes, wrapped DEKs, and audit rows. This does not encrypt database metadata, model definitions, run cursors/watermarks, sync plans, logs, or data retained by external sources. Source secrets and the KEK reside in the OS keychain. Protect the data directory and backups with OS permissions. SQLCipher is deferred.

Admin key management is available under /v1/admin/keys and System → Backups → Security. KEK rotation re-wraps every DEK in one transaction. A pending KEK remains in the OS keychain across the commit/replacement window, so startup can finish a committed rotation; the old active entry is replaced only after commit. Dataset rotation waits until its active runs finish, retires its DEK, and allocates a new one for the next run. Cleanup retains retired keys while any snapshot or checkpoint references them.

Database backups do not back up OS keychain secrets or Parquet files. Retain a protected, matching OS keychain backup when planning disaster recovery, including before KEK rotation: an older state.db backup may require the older KEK version. Losing the KEK makes its wrapped data irrecoverable. The restore command does not rewrite keys. mTLS is deferred; remote API and SQL connections require server TLS and bearer/user-token authentication.

## Audit integrity

Every audit row hashes its predecessor's 64-character lowercase hex hash followed by compact UTF-8 JSON with lexicographically sorted fields: action, at (Unix seconds), detail (a string), entity_id, id, principal_id (string or null). SHA-256 produces a lowercase hex hash; the genesis predecessor is 64 zero characters. SQLite serializes insertion and head lookup inside the caller's transaction. Existing rows are backfilled once, transactionally, without rewriting their contents. Subsequent startup does not repair a tampered chain.

Admins can GET /v1/audit/verify or run straton-engine verify-audit while the engine is stopped. The result is {ok, rows, first_bad_id}; the CLI exits unsuccessfully for a broken chain. /v1/status exposes audit_head for external anchoring. Append-only triggers deter ordinary modification. The chain detects changes relative to its trusted head; a party able to rewrite the entire database can recompute it or truncate a valid suffix. Retain heads in a separately trusted system to detect that. This is tamper evidence, not a digital signature.

## Supply chain checks

CI runs Rust formatting, clippy, tests, cargo-deny advisories/licenses/sources/bans, npm audit at high severity, desktop formatting/build/tests, and signed release generation. deny.toml allows only crates.io sources and lists one scoped license exception (tiny-keccak 2.0.2, CC0-1.0). Vulnerability advisories have no ignored entries. Dependency tools need trusted registry/advisory access in CI; an offline build alone does not establish current advisory status.
