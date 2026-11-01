# Access control

Users, roles, grants, row filters and column masks, enforced inside the SQL engine.

On startup the engine imports the existing `data/token` as the bootstrap token of user `admin`. It keeps the file with user-only permissions and stores only the token’s SHA-256 hash in SQLite. The built-in `admin` role has `is_admin=1`: this explicitly models global administration without adding a global grant target. Ordinary grants target a source or dataset; source grants include all datasets in that source, and target `admin` implies `read` and `sync_admin`. Source configuration and dataset policies accept matching target admin grants. Creating sources and global account, role, grant and backup administration require the built-in admin role. User deletion disables the account to retain audit history. The built-in user and role are protected from renaming, disabling, deletion and role reassignment; their tokens can be issued and revoked normally. Restarting does not reactivate a revoked bootstrap token. Issue a replacement admin token before revoking it.

The desktop sidebar shows the signed-in user. Administrators manage users, tokens, role grants, row filters and column masks under **Admin → Team & Permissions**. Tokens are displayed once in a Sheet and are never saved to localStorage. The Lineage map shows row-filter locks and masked-column badges; administrators can preview a role using **View as role**. This preview changes the map only; SQL continues to use the signed-in user’s permissions.

Use the bootstrap authorization header from the engine instructions above. For example, create a read role and user, grant a dataset, then issue a token:

```powershell
$base = "http://127.0.0.1:8787"
$headers = @{ Authorization = "Bearer $(Get-Content data/token -Raw)" }
function AccessApi($path, $body, $method = "Post") {
  Invoke-RestMethod "$base/v1/$path" -Method $method -Headers $headers -ContentType application/json -Body ($body | ConvertTo-Json -Depth 8)
}
$role = AccessApi "roles" @{ name="analyst" }
$user = AccessApi "users" @{ name="alice" }
AccessApi "users/$($user.id)/roles" @{ role_ids=@($role.id) } "Put"
$map = Invoke-RestMethod "$base/v1/datamap" -Headers $headers
$dataset = $map.nodes | Where-Object { $_.type -eq "dataset" -and $_.name -eq "users" } | Select-Object -First 1
AccessApi "grants" @{ role_id=$role.id; target_kind="dataset"; target_id=$dataset.id; privilege="read" }
$issued = AccessApi "users/$($user.id)/tokens" @{ name="BI client"; expires_at=$null }
# Copy $issued.token securely now. GET token lists never return the secret or its hash.
```

New tokens have `stn_` followed by 32 random bytes encoded as hex. Supply an optional Unix-second `expires_at`. List token metadata with `GET /v1/users/<user>/tokens`; revoke with `DELETE /v1/users/<user>/tokens/<token-id>`. Disabled users, expired tokens and revoked tokens cannot authenticate, including on the next statement of an existing SQL connection. `last_used_at` writes are throttled to once per minute. `GET /v1/me` returns the user, roles, and privilege summary. Read users cannot manage sources or jobs; `sync_admin` is required for jobs and runs on the granted source or dataset.

Policies attach to a dataset and role. Validate before saving; example predicate and mask:

```powershell
AccessApi "policies/validate" @{ dataset_id=$dataset.id; predicate="id >= 100 AND name IS NOT NULL" }
AccessApi "datasets/$($dataset.id)/row-filters/$($role.id)" @{ predicate="id >= 100 AND name IS NOT NULL" } "Put"
AccessApi "datasets/$($dataset.id)/masks/$($role.id)/name" @{ kind="redact" } "Put"
Invoke-RestMethod "$base/v1/datasets/$($dataset.id)/policies" -Headers $headers
# DELETE the same policy URL to remove a filter or mask.
```

Predicates allow only local columns, literals, comparisons, boolean and arithmetic operators, IN lists, LIKE, IS NULL, BETWEEN, CAST, and deterministic scalar functions. Subqueries, aggregates, window functions, volatile or time-dependent functions, variables, and other-table references are refused. Original predicate text is stored and revalidated against the query’s snapshot schema. An invalid stored predicate denies that role access to the dataset and records `policy.invalid`; it never grants unfiltered access.

Only read-granting roles participate in policies. Their row filters combine with **OR**; a read-granting role without a filter allows all rows. A column is masked only when **every** read-granting role masks it. If all mask it, the strictest kind wins: **null > redact > hash > last4**. `null` preserves the column type; `redact` produces `***`; `hash` produces SHA-256 hex of the value cast to UTF-8; `last4` prefixes its last four characters with `****`. Non-null masks produce UTF-8 columns. The built-in admin role grants global read access and initially has no filters or masks, so it is unrestricted by default. Policies attached to that role follow the same combination rules, including fail-closed validation. Local lake aliases require their own applicable grants; granting a source table does not expose a second raw alias.

Each SQL session registers only authorized views: current Parquet scan → row filter → mask projection. Raw tables are never registered. REST SQL previews, table listings and pgwire use the same enforcement. Datamap nodes and edges touching unreadable datasets are hidden; empty sources are hidden for non-administrators, and filtered datasets do not expose raw row counts. Non-admin event streams send refresh notifications without global run details. Administrative mutations and manual run requests record the real user ID in `audit_log.principal_id`; SQL audit details also identify that user. Tokens and token hashes never appear in audit details.

```powershell
psql "host=127.0.0.1 port=5433 dbname=straton user=alice sslmode=disable"
# At the password prompt, paste Alice’s token. The username and token owner must match.
```
