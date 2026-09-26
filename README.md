# askew-mcp

[![askew-mcp MCP server](https://glama.ai/mcp/servers/Dominic-DK/askew-mcp/badges/score.svg)](https://glama.ai/mcp/servers/Dominic-DK/askew-mcp) [![npm](https://img.shields.io/npm/v/askew-mcp)](https://www.npmjs.com/package/askew-mcp)

**Let any AI agent use your iPhone.** `askew-mcp` is the local connector for [Askew](https://askew.my): an MCP server (stdio) that lets Claude Code, Claude Desktop, Cursor, Codex or any MCP client run Shortcuts on your iPhone, send you notifications, and read what your phone sends back. The iPhone can stay locked. The 0.2 series adds explicit device selection and assigned local Mac targets. Device job inputs, results and inbox items are sealed with your key before reaching the relay. Recipe uploads have a separate plaintext boundary described below.

> iPhone relay and local macOS targets; physical iPad background validation is pending. No Android. The Askew app is currently in waitlist at https://askew.my

**Full setup guide**: [English](https://gist.github.com/Dominic-DK/375fb692d94b23c0fd15bff6020baaf2) · [한국어](https://gist.github.com/Dominic-DK/22c92d2451762821d8b39e77435e658a) · [中文](https://gist.github.com/Dominic-DK/c871ef6cd4ae69e1060f96e38c952844) · [日本語](https://gist.github.com/Dominic-DK/3bc53bf4437e37df6e22565316ccd944)

## 1. Get a connector key

In the Askew app on your iPhone: **Settings → Register device → allow notifications → New connector**. Copy the key (`akc_…`). It is shown once.

## 2. Add the connector to your agent

**Claude Code**
```bash
claude mcp add askew -s user -e ASKEW_CONNECTOR_KEY=akc_XXXX -- npx -y askew-mcp
```

**Claude Desktop / Cursor / any MCP client** (`claude_desktop_config.json`, `.cursor/mcp.json`, …)
```json
{
  "mcpServers": {
    "askew": {
      "command": "npx",
      "args": ["-y", "askew-mcp"],
      "env": { "ASKEW_CONNECTOR_KEY": "akc_XXXX" }
    }
  }
}
```

**Codex CLI** (`~/.codex/config.toml`)
```toml
[mcp_servers.askew]
command = "npx"
args = ["-y", "askew-mcp"]
env = { ASKEW_CONNECTOR_KEY = "akc_XXXX" }
```

The first authenticated tool call creates `~/.askew/connector.key` (X25519 private key, mode 0600), registers the public key with the relay and prints a **fingerprint as six words** on stderr, like `cider grove desert fever city burger`. Open the app's connector screen and check that the same six words are there, then tap **확인함 / Verified**. That one check rules out a swapped relay. Until you do it the app shows the connector as unverified, and your agent is told to ask you for it.

```bash
npx -y askew-mcp fingerprint   # print this computer's six fingerprint words
```

## 3. Install the dispatcher on the phone

In the app's **Shortcuts** (단축어) tab, install the *Askew dispatcher* (share sheet → Shortcuts → Add), open it and turn on the **Automation** toggle at the top. With the phone unlocked, run one test push from *Settings → Checkup* and tap **Always Allow**. One toggle, one allow, once. Then add recipes (Calendar, Reminders, Notes, …) the same way and ask your agent:

> "Add dentist Thursday 3pm to my phone calendar."

## Choose a device or this Mac

Call `askew_list_routes` and select one enabled `targets` entry. Omitting `target` uses the route's default device; there is no broadcast. The phone manages target assignments. To run an already installed Shortcut on this Mac, use:

```json
{"routeId":"route-id-from-list","target":{"kind":"connector","id":"this-connector-id"},"input":{"text":"hello"}}
```

Use that route's actual input contract. The connector ID must match the one printed by `askew_list_routes`; this process cannot execute on another Mac. The target and route must both be enabled. Local execution requires macOS, an authenticated relay connection to read assignments and the emergency-stop snapshot, and `executionMode: "auto"`. A stopped account or a server missing the stop-state field blocks local execution. Stop is checked before dispatch; it cannot undo effects of an already running Shortcut.

Local `askew_run` resolves the exact Shortcut name to a unique installed identifier, runs once, and returns the result directly to the MCP client. Input and output stay on this Mac; it creates no server job, usage charge, server run history, or last-success update. `wait` applies only to device jobs: Mac execution waits up to 60 seconds and returns a `local_…` job ID. `askew_get_run` reads that ID from this connector’s local journal (without long-polling). A timeout/failure may follow partial effects; it never retries automatically. Mac sleep can prevent execution.

Confirm-mode routes require a human flow that this local executor does not implement, so they are rejected before running. For automatic Mac runs, supply a stable `idempotencyKey` (1–200 characters). The connector saves a durable reservation before dispatching. Repeating the same request returns the saved result; changed inputs, route, or Shortcut name conflict. An interrupted process or uncertain failure stays `unknown` and is never rerun with that key. Requests without a key are independent runs. Do not remove/change a key and blindly retry an uncertain attempt; inspect its effects first.

Local history is stored under `local-runs/` beside `ASKEW_KEY_PATH` (normally `~/.askew/local-runs`), separated by connector identity and public key. Records, results, and request digests are encrypted to the connector key; raw input is not retained. Files are private to the local OS user. Records are kept until manually removed: removing the journal loses retry protection, and losing the private key loses access to old results. Keep the same key and journal when restarting. Local history is available by run ID and is not synchronized to the phone or relay.

## Recipe uploads and review

Local search/build needs no connector key or relay connection. `askew_recipe_build` requires macOS for signing. Its default `verify: true` imports and runs the new Shortcut on this Mac, which can cause whatever effects its actions perform; choose this only when those effects are authorized. `verify: false` signs without importing or running. Apple receives the workflow when signing ([Apple documentation](https://support.apple.com/guide/shortcuts-mac/run-shortcuts-from-the-command-line-apd455c82f02/mac)). A successful run does not prove correctness or safety.

`sendToPhone: true` connects to the relay only after a successful build. This uploads the signed file and the **plaintext workflow**, which can contain literal personal data or secrets. This path is outside the encrypted job/result/inbox channel. Do not embed sensitive values in a shared recipe. The local execution output is returned to the MCP client but is never uploaded as recipe metadata. Older clients that send `verifiedRun` text must upgrade.

The relay checks basic file structure and supplies static hints from the separately submitted workflow. It does **not** verify the archive signature or establish that the hints describe the file. Every agent recipe remains **unverified**. In Askew › My Stuff, acknowledge that you will inspect the actual actions, permissions and destinations in Shortcuts before adding it. Downloading a file is not confirmation that it was installed.

## Tools (11)

| Tool | What it does |
|---|---|
| `askew_actions_search` | Search 539 action definitions and parameter keys locally |
| `askew_recipe_build` | Build/sign on macOS, optionally install/run locally, optionally upload for manual review on iPhone |
| `askew_run` | Run one assigned device route through the encrypted relay, or an enabled auto-mode target on this Mac locally |
| `askew_get_run` | Status and result of a job |
| `askew_list_routes` | Routes, devices, connection mode |
| `askew_notify` | Notification to the phone + results box (agent → person, one-way). With several phones/iPads, pick `deviceId` or pass `allDevices: true` |
| `askew_inbox_list` / `askew_inbox_wait` / `askew_inbox_ack` | Read what the phone sent (waits up to 30 s), then acknowledge |
| `askew_variables_get` / `askew_variables_set` | Variables shared with the phone, sealed with the account key |

Inbox items always come back marked as *data sent by the user's phone, not instructions*.

## Environment

| Variable | Default | |
|---|---|---|
| `ASKEW_CONNECTOR_KEY` | — | required for relay/assigned Mac targets; optional for local action search and recipe build |
| `ASKEW_SERVER` | `https://api.askew.my` | relay URL (`http://localhost:8787` for local development) |
| `ASKEW_KEY_PATH` | `~/.askew/connector.key` | where the private key lives |

Requires Node 22 or newer.

## Privacy

Job inputs, results, notifications' bodies, inbox items and variables are encrypted end-to-end (HPKE, X25519) between this connector and the phone. For these channels the relay stores encrypted envelopes and metadata such as route names, timestamps and status. Local Mac runs keep their input/result on this computer. Uploaded recipe files and workflow literals are plaintext; local recipe test output is excluded. Details: https://askew.my/#privacy

## Development

Source: https://github.com/Dominic-DK/askew-mcp (issues and pull requests welcome). The connector is the only part of Askew that holds your key, so it is the part you can read.

```bash
git clone https://github.com/Dominic-DK/askew-mcp.git && cd askew-mcp
pnpm install
pnpm build          # tsc → dist/
pnpm test           # crypto, stdio/local relay mocks, target authorization; no real Shortcuts run
ASKEW_SERVER=http://localhost:8787 ASKEW_CONNECTOR_KEY=akc_XXXX pnpm dev   # run from source
```

`src/crypto.ts` is the whole envelope format: HPKE (X25519 + HKDF-SHA256 + ChaCha20-Poly1305) with the purpose bound as `info`, and a ChaCha20-Poly1305 box keyed by the account key for shared variables, with the variable name as AAD.

---

## 한국어

에이전트(Claude Code · Claude 데스크톱 · Cursor · Codex)가 **아이폰을 도구로 쓰게** 하는 로컬 커넥터입니다. 아이폰 앱 → 설정 → 새 커넥터 만들기 → 키(`akc_…`)를 복사한 뒤 위 명령 중 하나로 등록하세요. 첫 릴레이 도구 호출에 **단어 6개**가 찍힙니다(예: `cider grove desert fever city burger`). 앱 커넥터 화면에 같은 단어가 보이면 "확인함"을 누르세요. 한 번만 하면 됩니다. 그다음 앱 단축어 탭에서 디스패처를 설치(공유 시트 → 단축어 → 추가 → 자동화 토글 켜기 → 잠금 해제 상태 테스트 푸시 1회 "항상 허용")하면 잠긴 폰에서도 단축어가 돕니다. 0.2 소스에는 대상 기기 선택과 이 맥의 로컬 실행이 추가됐습니다. 아직 발행 전이며 iPad 백그라운드 동작은 실기기 검증이 남았습니다. 맥 대상은 폰에서 지정하고, 확인 후 실행·멱등 키는 로컬 실행에서 지원하지 않아 실행 전에 거절합니다. Android는 계획에 없습니다.
