# Changelog

## 0.1.1 — 2026-09-18

- Source is public at https://github.com/Dominic-DK/askew-mcp (MIT). `repository` and `bugs` fields point there so npm links to it.
- Unit tests for the envelope format: HPKE seal/open with purpose binding, account-key box with the variable name as AAD, fingerprint format, key file created 0600 and reloaded.
- `mcpName` for the official MCP Registry and a `server.json`.
- Test-only dependencies removed from `devDependencies`.

## 0.1.0 — 2026-09-18

- First release. stdio MCP server with 9 tools: `askew_run`, `askew_get_run`, `askew_list_routes`, `askew_notify`, `askew_inbox_list`, `askew_inbox_wait`, `askew_inbox_ack`, `askew_variables_get`, `askew_variables_set`.
- End-to-end encryption between this connector and the phone (HPKE: X25519, HKDF-SHA256, ChaCha20-Poly1305). Connector key at `~/.askew/connector.key`, fingerprint printed on first run for a one-time check against the app.
- Shared variables sealed with the account key the phone hands over.
