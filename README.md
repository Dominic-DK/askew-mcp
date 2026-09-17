# askew-mcp

**Let any AI agent use your iPhone, iPad or Mac.** `askew-mcp` is the local connector for [Askew](https://askew.my): an MCP server (stdio) that lets Claude Code, Claude Desktop, Cursor, Codex or any MCP client run Shortcuts on your Apple devices, send you notifications, and read what your phone sends back. The iPhone can stay locked. Recipes sync across devices via iCloud; iPad and Mac support is in testing. Inputs, results and inbox items are sealed on this computer with your key, so the relay never sees plaintext.

> iPhone (iOS 27) verified · iPad (iPadOS 27) and Mac in testing · no Android · the Askew app is currently in waitlist at https://askew.my

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

The first run creates `~/.askew/connector.key` (X25519 private key, mode 0600), registers the public key with the relay and prints a **fingerprint** on stderr. Compare it with the fingerprint shown in the app's connector screen once; that check rules out a swapped relay.

```bash
npx -y askew-mcp fingerprint   # print this computer's connector fingerprint
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

---

## 한국어

에이전트(Claude Code · Claude 데스크톱 · Cursor · Codex)가 **아이폰을 도구로 쓰게** 하는 로컬 커넥터입니다. 아이폰 앱 → 설정 → 새 커넥터 만들기 → 키(`akc_…`)를 복사한 뒤 위 명령 중 하나로 등록하세요. 첫 실행에 찍히는 지문을 앱 커넥터 화면의 지문과 한 번 맞춰 보세요. 그다음 앱 프리셋 탭에서 디스패처를 설치(공유 시트 → 단축어 → 추가 → 자동화 토글 켜기 → 잠금 해제 상태 테스트 푸시 1회 "항상 허용")하면 잠긴 폰에서도 단축어가 돕니다. iPhone(iOS 27) 확인됨, iPad·Mac은 테스트 중. Android 없음.
