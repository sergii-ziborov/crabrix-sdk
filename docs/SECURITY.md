# Security boundaries

This library accepts only complete HTTPS Crabrix room links at crabrix.com.
It rejects other origins, user information, query parameters, expired links and
invalid capability shapes. It never logs private links or plaintext source.
Production origin is fixed; loopback injection exists only in internal tests.

Agent links reach a room like person links, with the same access and expiry, and
cannot mint other links. Crabrix MCP decrypts on this computer with the key from
the link. `crabrix serve-http` is different: it receives agent links whose key is
in the path and holds that key and the decrypted room in process memory while an
agent session lasts. It logs no links, writes nothing to disk and never compiles or
runs code. Run it only behind TLS, with request logging off for its path. Local
agent links keep the key after `#`, so no HTTP client sends it and the remote MCP
refuses them.

The Academy tools read public lessons only. `crabrix_academy_import_progress_backup`
exists only on the local `crabrix academy` stdio server: it opens a regular
`.crabrixprogress` file the learner names, read-only (no symbolic links, devices or pipes,
at most 5 MiB), uses only its lesson ids and sends nothing from it. An AI Learning State is
learner data: validation refuses links with keys, private key blocks and token-like strings
without echoing them. `/mcp/academy` can be paused with `--no-academy` or
`CRABRIX_ACADEMY_MCP=off`; agent links are unaffected.

A learning link (`/mcp/learn/<linkId>/<secret>`) is the learner's capability for their own
progress, created and revoked in the Crabrix app. `crabrix serve-http` derives the keys from
the secret in the path, sends the website only the derived read token, decrypts the progress
snapshot in memory, validates it strictly and keeps it for at most 10 seconds, keyed by a hash of
the whole link. It writes nothing to disk and logs no link. Tutor messages are built from validated
input, never from agent text passed through, and are encrypted for the app. Nothing in this path
can mark progress. Learning links pause with the same `--no-academy` / `CRABRIX_ACADEMY_MCP=off`
switch, and an AI Learning State refuses a learning link.

Joining and source editing cannot execute code. Signed runtime requests require
an explicit short-lived grant on one target client. Source/comments/diagnostics
and output are untrusted content, not agent instructions. A participant name is
a display label, not identity verification. Compare runtime fingerprints.

Source edits use a fresh decrypted snapshot, exact content revision, conditional
relay sequence and deduplicated message ID. A timed-out or ambiguous operation
must be reconciled before a new proposal. Revision conflicts are not retried as
blind replacements. The room is temporary and is not a backup or repository.

Report a suspected vulnerability privately at https://crabrix.com/support/.
Do not post real capability links, user source or access tokens in public issues.
