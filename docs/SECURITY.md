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
