# Deployment

Straton is one binary plus a working directory holding `straton.toml`, the SQLite state file,
Parquet data, backups and logs.

## Checklist

- Run as a dedicated, unprivileged user that owns the working directory.
- Keep the REST and SQL binds on `127.0.0.1` behind a reverse proxy, or set `tls_cert` and
  `tls_key`: non-loopback binds refuse to start without TLS.
- On Linux, set `STRATON_SECRETS_DIR` so the encryption key and connector secrets survive a
  reboot, and back that directory up separately from data backups.
- Set `[network] allow_private = false` when sources are on the public internet only.
- Verify release signatures before installing (see [Security](../security/index.md)).

## Linux (systemd)

```ini
--8<-- "deploy/straton-engine.service"
```

## Windows

--8<-- "deploy/windows-service.md"

## Backups and restore

Backups run daily at 02:00 UTC by default and keep the newest seven snapshots.
`POST /v1/backups` creates one now; `GET /v1/backups` lists them. Stop the engine, then
restore from the same working directory:

```bash
straton-engine restore data/backups/<snapshot.db>
```

Restore validates the snapshot and replaces state (users and token hashes included). It does
not restore the bootstrap token file, configuration or logs. Database backups exclude Parquet
data and keychain secrets; plan key recovery alongside data recovery.
