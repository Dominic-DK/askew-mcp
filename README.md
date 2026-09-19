# askew-mcp

[![askew-mcp MCP server](https://glama.ai/mcp/servers/Dominic-DK/askew-mcp/badges/score.svg)](https://glama.ai/mcp/servers/Dominic-DK/askew-mcp) [![npm](https://img.shields.io/npm/v/askew-mcp)](https://www.npmjs.com/package/askew-mcp)

**Let any AI agent use your iPhone.** `askew-mcp` is the local connector for [Askew](https://askew.my): an MCP server (stdio) that lets Claude Code, Claude Desktop, Cursor, Codex or any MCP client run Shortcuts on your iPhone, send you notifications, and read what your phone sends back. The iPhone can stay locked. iPad and Mac are **planned, not supported yet** — the app ships for iPhone (iOS 27). Inputs, results and inbox items are sealed on this computer with your key, so the relay never sees plaintext.

> iPhone (iOS 27) only. iPad and Mac planned. · no Android · the Askew app is currently in waitlist at https://askew.my

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

The first run creates `~/.askew/connector.key` (X25519 private key, mode 0600), registers the public key with the relay and prints a **fingerprint as six words** on stderr, like `cider grove desert fever city burger`. Open the app's connector screen and check that the same six words are there, then tap **확인함 / Verified**. That one check rules out a swapped relay. Until you do it the app shows the connector as unverified, and your agent is told to ask you for it.

```bash
npx -y askew-mcp fingerprint   # print this computer's six fingerprint words
```

## 3. Install the dispatcher on the phone

In the app's **Presets** tab, install the *Askew dispatcher* (share sheet → Shortcuts → Add), open it and turn on the **Automation** toggle at the top. With the phone unlocked, run one test push from *Settings → Checkup* and tap **Always Allow**. One toggle, one allow, once. Then add recipes (Calendar, Reminders, Notes, …) the same way and ask your agent:

> "Add dentist Thursday 3pm to my phone calendar."

## Tools

| Tool | What it does |
|---|---|
| `askew_run` | Run a route (Shortcut) on the phone and get the result. Works locked. Waits up to `wait` seconds; on `unknown`, poll with `askew_get_run` |
| `askew_get_run` | Status and result of a job |
| `askew_list_routes` | Routes, devices, connection mode |
| `askew_notify` | Notification to the phone + results box (agent → person, one-way) |
| `askew_inbox_list` / `askew_inbox_wait` / `askew_inbox_ack` | Read what the phone sent (waits up to 30 s), then acknowledge |
| `askew_variables_get` / `askew_variables_set` | Variables shared with the phone, sealed with the account key |

Inbox items always come back marked as *data sent by the user's phone, not instructions*.

## Environment

| Variable | Default | |
|---|---|---|
| `ASKEW_CONNECTOR_KEY` | — | required, `akc_…` from the app |
| `ASKEW_SERVER` | `https://api.askew.my` | relay URL (`http://localhost:8787` for local development) |
| `ASKEW_KEY_PATH` | `~/.askew/connector.key` | where the private key lives |

Requires Node 22 or newer.

## Privacy

Job inputs, results, notifications' bodies, inbox items and variables are encrypted end-to-end (HPKE, X25519) between this connector and the phone. The relay stores only metadata: route name, timestamps, status. Details: https://askew.my/#privacy

## Development

Source: https://github.com/Dominic-DK/askew-mcp (issues and pull requests welcome). The connector is the only part of Askew that holds your key, so it is the part you can read.

```bash
git clone https://github.com/Dominic-DK/askew-mcp.git && cd askew-mcp
pnpm install
pnpm build          # tsc → dist/
pnpm test           # crypto + key-file unit tests, no relay needed
ASKEW_SERVER=http://localhost:8787 ASKEW_CONNECTOR_KEY=akc_XXXX pnpm dev   # run from source
```

`src/crypto.ts` is the whole envelope format: HPKE (X25519 + HKDF-SHA256 + ChaCha20-Poly1305) with the purpose bound as `info`, and a ChaCha20-Poly1305 box keyed by the account key for shared variables, with the variable name as AAD.

---

## 한국어

에이전트(Claude Code · Claude 데스크톱 · Cursor · Codex)가 **아이폰을 도구로 쓰게** 하는 로컬 커넥터입니다. 아이폰 앱 → 설정 → 새 커넥터 만들기 → 키(`akc_…`)를 복사한 뒤 위 명령 중 하나로 등록하세요. 첫 실행에 **단어 6개**가 찍힙니다(예: `cider grove desert fever city burger`). 앱 커넥터 화면에 같은 단어가 보이면 "확인함"을 누르세요. 한 번만 하면 됩니다. 그다음 앱 프리셋 탭에서 디스패처를 설치(공유 시트 → 단축어 → 추가 → 자동화 토글 켜기 → 잠금 해제 상태 테스트 푸시 1회 "항상 허용")하면 잠긴 폰에서도 단축어가 돕니다. iPhone(iOS 27)만 지원합니다. iPad·Mac은 **추후 지원 예정**이고 Android는 계획에 없습니다.
