# Straton

**Status:** v1 in progress

## Vision

An open-source, self-hosted, Rust-based data platform for data and ML engineers: fast, secure, and simpler to operate. It would cover the core data-platform capabilities associated with Databricks while remaining configurable rather than including a built-in natural-language assistant.

## Capabilities

- Connect, sync, and transform data across SaaS, CRM, ERP, and developer tools: Salesforce, SAP, Stripe/payment platforms, ServiceNow, Jira, Confluence, Cornerstone, and more.
- SQL endpoint/server for remote clients; RBAC for multiple users.
- An access-control and metadata layer—working name: **Access Control Manager**—similar in purpose to a catalog, but independently designed.
- Data engineering and ML-engineering workloads.
- Federated computation: plan work close to data sources where appropriate, minimizing data movement.
- Optimize user-defined logic across a pipeline. Example: detect compensating transformations such as `+1` before a sync and `-1` at the destination, then eliminate unnecessary work while preserving semantics.

## Security baseline

- Secure-by-default configuration; explicit trust boundaries for users, connectors, and workloads.
- Encryption in transit (TLS; mutual TLS for service-to-service paths where appropriate) and encryption at rest with managed keys/key rotation.
- Strong identity integration, least-privilege RBAC, scoped connector credentials, and no secrets in logs or configuration files.
- Immutable audit logs for access, policy changes, queries, and data movement.
- Tenant/workload isolation, query limits, safe handling of untrusted expressions, and tested backup/restore procedures.
- Signed releases, dependency/SBOM scanning, timely patching, threat modeling, and security testing guided by [OWASP Top 10](https://owasp.org/projects/top-ten) and [OWASP ASVS](https://owasp.org/projects/asvs).

## Scope decision

Do **not** attempt full Databricks parity in v1. Start with one sharp wedge: self-hosted connector sync plus optimized transformations and policy-aware SQL access. Expand only after that workflow is reliable.

## Open questions

- Which connector and workload are the first target?
- What execution/storage architecture best serves the first use case?
- Which optimizations are provably safe, explainable, and reversible?
- Which enterprise security/compliance requirements matter first?
