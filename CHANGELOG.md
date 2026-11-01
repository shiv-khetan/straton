# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may break interfaces).

## [Unreleased]

### Added
- Documentation site (MkDocs Material) published to GitHub Pages, with an API reference
  generated from the engine's route contract test.
- Open-source project files: license, contributing guide, code of conduct, issue and pull
  request templates, Dependabot, CodeQL, desktop release builds.
- Column profiling (`POST /v1/explorer/profile`) and the Settings page.
- File-backed secret store (`STRATON_SECRETS_DIR`) so Linux keeps keys across reboots.
- Connector egress policy (`[network] allow_private`); metadata and link-local addresses are
  always refused.
- Bulk job actions, schedule field with presets and live feedback, readable SQL errors.

### Security
- Scoped source administrators can no longer repoint a source's location or credentials.
- Source paths inside the engine's data or backup directories are refused.
- Security headers on every API response; pgwire connection cap; export row cap; hardened
  desktop OAuth callback; connector errors no longer echo driver text.

## [0.1.0]

- Initial engine, connectors, SQL endpoint, access control, encryption at rest, audit chain
  and desktop app.
