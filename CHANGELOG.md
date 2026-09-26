# Changelog

## 0.2.2 — 2026-09-26

- `askew_notify` no longer broadcasts to every device by default. When the account has more than one phone/iPad it returns `DEVICE_REQUIRED` with the device list unless `deviceId` or the new `allDevices: true` is given. This matches the relay's rule and stops silently charging one round trip per device.
- README: the app tab is "Shortcuts" (단축어), not "Presets".

## 0.2.1 — 2026-09-21

- Add a durable, encrypted local run journal. Reserve before dispatch; the same idempotency key never reruns after restart or an uncertain failure while its journal record is retained.
- Return local run IDs and support `askew_get_run` for saved local results. Retain only encrypted result/metadata and an encrypted request digest, not raw input.
- Reject conflicting requests and fail closed on unreadable records. Keep confirm-mode execution unsupported.
- Publish first-time keys atomically and share concurrent connection setup to prevent duplicate identities and duplicate execution.
- Correct the stale 0.2.0 publication notice and narrow registry wording to distinguish phone relay execution from this Mac.

## 0.2.0 — 2026-09-21

- Add local action search (539 definitions) and macOS recipe build/sign/run tools (11 tools total).
- Bootstrap relay authentication only when a remote action or successful recipe upload needs it; local tools remain usable without a key.
- Report build and upload failures with MCP `isError`.
- Exclude local execution output from recipe uploads. Uploaded workflow/file remains plaintext; file contents are unverified and need manual review in Shortcuts.
- Include the action catalog in the Docker build.
- Add assigned Mac targets to `askew_run`: own connector only, enabled auto-mode route, fresh stop-state snapshot, local payload/result, no relay job/quota. Confirm-mode and idempotency keys are rejected before effects. Resolve one installed UUID, execute once without shell/retry, and remove temporary files.
- Keep registry manifest at 0.2.0 and make connector key optional for local search/build.

## 0.1.4 (2026-09-19)
- `askew_notify`가 기기마다 따로 호출하지 않고 **한 요청**으로 보낸다(`targets`). 예전엔 기기가 여럿일 때
  중간에 한도에 걸리면 앞의 기기는 이미 받은 채로 실패해, 에이전트가 재시도하면 중복으로 도착했다.
  봉투는 기기 공개키로 봉하므로 기기별 봉투를 함께 담는다.
- 기기를 지정하지 않았는데 계정에 기기가 여럿이면 서버가 `DEVICE_REQUIRED`로 고르게 한다(조용히 뿌리지 않는다).


## 0.1.3 — 2026-09-18

- Every tool and every parameter now carries a full description (behavior, return value, errors, usage guidance) so agents and directories can pick the right tool without reading the README.
- README: Glama score badge.

## 0.1.2 — 2026-09-18

- Starts without `ASKEW_CONNECTOR_KEY` and when the relay is unreachable: `tools/list` always answers, and each tool call retries the connection and returns a clear `isError` text instead of the process exiting. Directory health checks (Glama, awesome-mcp-servers) and agents that start the server before the key is configured now see the tools.
- `Dockerfile` (build from source) and `glama.json`.

## 0.1.1 — 2026-09-18

- Source is public at https://github.com/Dominic-DK/askew-mcp (MIT). `repository` and `bugs` fields point there so npm links to it.
- Unit tests for the envelope format: HPKE seal/open with purpose binding, account-key box with the variable name as AAD, fingerprint format, key file created 0600 and reloaded.
- `mcpName` for the official MCP Registry and a `server.json`.
- Test-only dependencies removed from `devDependencies`.

## 0.1.0 — 2026-09-18

- First release. stdio MCP server with 9 tools: `askew_run`, `askew_get_run`, `askew_list_routes`, `askew_notify`, `askew_inbox_list`, `askew_inbox_wait`, `askew_inbox_ack`, `askew_variables_get`, `askew_variables_set`.
- End-to-end encryption between this connector and the phone (HPKE: X25519, HKDF-SHA256, ChaCha20-Poly1305). Connector key at `~/.askew/connector.key`, fingerprint printed on first run for a one-time check against the app.
- Shared variables sealed with the account key the phone hands over.
