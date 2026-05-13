# cliclaw

세 가지 로컬 코딩 CLI(**Claude Code · Codex · Pi**)를 텔레그램에서 바꿔가며 쓸 수 있게 해주는 단일 데몬.

채팅마다 에이전트별 세션을 독립적으로 유지하고, 위험 명령에 대한 confirm 게이트와 응답 스트리밍, 이미지 첨부 처리까지 지원합니다.

## 동작 개요

1. Telegram Bot API `getUpdates` long-poll
2. 채팅마다 현재 선택된 에이전트로 메시지를 디스패치
   - `claude -p <prompt> --output-format stream-json --resume <id>`
   - `codex exec [resume --last] -s <sandbox> -o <last_message> <prompt>` (per-chat `CODEX_HOME`)
   - `pi -p --mode text --session-dir <chat_dir> [--continue] <prompt>`
3. `sessions.json` 에 채팅별 `{ active, agents: { claude, codex, pi } }` 영속화 → 에이전트 별 대화 이어감
4. 각 CLI 출력 파싱 → Telegram `sendMessage` 회신

## 빠른 시작

### 1. 사전 요구사항

- macOS (Apple Silicon 또는 Intel)
- [Bun](https://bun.sh) 1.x
- 사용할 코딩 CLI는 **본인 셸에서 이미 로그인된 상태**여야 합니다. 봇은 인증된 자식 프로세스를 spawn 할 뿐입니다.
  - Claude Code: <https://docs.claude.com/en/docs/claude-code/quickstart>
  - Codex CLI: <https://github.com/openai/codex>
  - Pi (선택): <https://github.com/earendil-works/pi-coding-agent>
- 세 CLI 모두 설치할 필요는 없습니다. 봇 시작 시 못 찾는 CLI가 있으면 에러로 종료되니, **쓰지 않을 에이전트는 `bot.ts`의 `AGENT_NAMES`에서 제거**하거나 PR을 환영합니다.

### 2. 봇 생성 (BotFather)

1. 텔레그램에서 [@BotFather](https://t.me/BotFather) 와 대화 → `/newbot`
2. 이름·username 입력 후 **HTTP API 토큰**을 받음 (`123456:ABC-DEF...` 형식)
3. (선택) `/setcommands` 로 명령어 등록:
   ```
   claude - Claude Code 모드로 전환
   codex - Codex 모드로 전환
   pi - Pi 모드로 전환
   status - 세션 상태
   stop - 진행 중 작업 취소
   reset - 현재 세션 폐기
   help - 도움말
   ```

### 3. 설치

```bash
git clone https://github.com/choiyounggi/cliclaw.git
cd cliclaw
bun install
cp config.example.json config.json
chmod 600 config.json
```

### 4. config.json 편집

```jsonc
{
  "token": "여기에 BotFather 토큰",
  "allowedUserIds": [],         // 첫 실행 시 비워두고, /start 로 자기 user_id 확인 후 채우기
  "cwd": "./workspace",         // 에이전트들이 작업할 디렉토리 (봇 디렉토리 기준 상대경로 OK)
  "defaultAgent": "claude",     // claude | codex | pi
  "agents": {
    "claude": { "path": "", "model": "sonnet" },
    "codex":  { "path": "", "model": null, "sandbox": "workspace-write" },
    "pi":     { "path": "", "model": null, "provider": null }
  }
}
```

`agents.*.path` 를 **빈 문자열로 두면** 봇이 자동으로 찾습니다:

1. `~/.local/bin`, `~/.claude/local`, `/usr/local/bin`, `/opt/homebrew/bin`
2. `$NVM_DIR` 또는 `~/.nvm` 의 가장 최신 node 버전 `bin/<cmd>`
3. 로그인 쉘(`zsh -l -i`)에서 `command -v <cmd>` 결과

세 단계 모두 실패하면 종료하면서 직접 경로를 적도록 안내합니다.

### 5. 실행

```bash
bun run start
```

### 6. 본인 user_id 확보

봇과 처음 대화하면 `허용되지 않은 사용자 ID: <숫자>` 형태로 회신됩니다. 그 숫자를 `config.json` 의 `allowedUserIds` 배열에 넣고 봇을 재시작하면 사용 시작.

```jsonc
"allowedUserIds": [123456789],
```

## 채팅 명령

| 명령 | 동작 |
|------|------|
| `/claude` `/codex` `/pi` | 이 채팅의 active 에이전트 전환 |
| `/status` | 모든 에이전트별 세션 상태 + 진행 중 작업 표시 |
| `/stop` | 현재 채팅의 진행 중 작업 취소 (SIGTERM → 5s 후 SIGKILL) |
| `/reset` | 현재 active 에이전트 세션만 폐기 |
| `/reset all` | 이 채팅의 모든 에이전트 세션 폐기 |
| `/start` `/help` | 도움말 |
| 그 외 텍스트 / 사진 | active 에이전트에 프롬프트 전달 (사진은 자동 다운로드 후 경로가 프롬프트 앞에 주입됨) |

에이전트 전환 시 그 에이전트의 기존 세션은 그대로 유지 — 다시 돌아오면 이어집니다. 진행 중 작업이 있는 채팅에 새 프롬프트를 보내면 거부됩니다 (`/stop` 또는 종료 대기).

## 주요 기능

### 1. 위험 명령 confirm 게이트 (Claude + Codex)
Bash 도구 호출 시 `bin/bash-confirm.ts` 훅이 Unix 소켓으로 봇에 질의 → 봇이 텔레그램에 inline keyboard `[✅ 허용] [❌ 거부]` 표시 → 사용자 응답 대기. 무응답 시 자동 거부.

기본 패턴: `rm -rf`, `git push --force`, DROP/TRUNCATE, `kubectl delete`, AWS `delete-*`, `sudo`, `curl|sh`, secret env export 등. `confirmGate.extraPatterns` 로 사용자 정의 regex 추가 가능.

### 2. 응답 스트리밍 (Claude)
`--include-partial-messages` 의 `text_delta` 를 받아 `editMessageText` 로 실시간 갱신. 1.5초 디바운스로 텔레그램 레이트리밋 회피. 3800자 넘으면 새 메시지로 롤오버 (코드 블록·문단 경계 우선). Codex/Pi 는 종료 시 한 번에 회신.

### 3. 이미지 첨부 처리
텔레그램의 사진/이미지 문서를 자동으로 `workspace/uploads/<chatId>/<msgId>.<ext>` 로 다운로드 후 경로를 프롬프트 앞에 추가. Claude/Codex가 Read 도구로 분석.

### 4. tool_use 즉시 회신
- **Claude**: stream-json 파싱으로 정확한 도구명·인자 추출 (`🔧 Bash: …`, `🔧 Read: …`)
- **Codex / Pi**: stdout 라인 휴리스틱

### 5. 한국어 UI
모든 사용자 메시지·에러·`/help` 가 한국어.

### 6. 타임아웃 정책
- `sessionTimeoutMs`: 하드 wall-clock
- `idleTimeoutMs`: N ms 동안 stdout 무활동 시 SIGTERM
- per-agent 오버라이드: `agents.<name>.timeoutMs` / `agents.<name>.idleTimeoutMs`

## 자동 시작 (launchd, 선택)

`samples/com.example.cliclaw.plist` 를 본인 환경에 맞게 수정 후:

```bash
cp samples/com.example.cliclaw.plist ~/Library/LaunchAgents/com.<username>.cliclaw.plist
# plist 안의 경로·UserName 치환 필요
launchctl load ~/Library/LaunchAgents/com.<username>.cliclaw.plist
launchctl start com.<username>.cliclaw
tail -f logs/bot.log
```

PATH가 빈 launchd 환경에서도 `lib/resolve-cli-path.ts` 의 login-shell 폴백 덕에 동작합니다.

## 파일 구조

```
cliclaw/
├── bot.ts                  # 메인 데몬
├── lib/
│   ├── resolve-cli-path.ts # claude/codex/pi 경로 자동 탐색
│   ├── audit-log.ts        # NDJSON 감사 로그 writer
│   ├── job-registry.ts     # 채팅별 in-flight 작업 추적 + AbortController
│   ├── stream-parser.ts    # Claude stream-json + Codex/Pi 휴리스틱
│   ├── subprocess-stream.ts# Bun.spawn 라인 단위 콜백 + abort/timeout
│   ├── danger-patterns.ts  # 기본 위험 패턴 세트
│   ├── confirm-server.ts   # Unix 소켓 IPC 서버
│   ├── hook-installer.ts   # Claude/Codex hooks.json 멱등 머지
│   ├── telegram-stream.ts  # debounced editMessageText + 자동 롤오버
│   ├── telegram-html.ts    # markdown → Telegram HTML
│   ├── tool-indicator.ts   # tool_use 인디케이터 디바운서
│   └── media-download.ts   # Telegram 파일 다운로드
├── bin/bash-confirm.ts     # Claude/Codex 가 spawn 하는 hook 스크립트
├── __tests__/              # 13 파일, 170+ 케이스
├── config.example.json
├── package.json
└── README.md
```

## 보안

- **봇 토큰 = 세 가지 CLI 모두에 대한 원격 셸**. 토큰 유출 시 BotFather `/revoke` 즉시.
- `allowedUserIds` 비면 모든 메시지 거부 (fail-closed).
- `confirmGate.enabled: false` 또는 codex sandbox 를 `danger-full-access` 로 바꾸지 말 것. 텔레그램 메시지 한 줄로 머신 전체 노출.
- `config.json` 권한 `600` 유지.

## 테스트

```bash
bun run test
```

## 알려진 한계

- 위험 패턴은 정규식 기반 — 100% 분류 어려움. 사용자가 직접 정책 유지.
- Codex/Pi 본문 텍스트 스트리밍 미지원 (구조화 이벤트 부재).
- 사용자 응답 시간 동안 hook이 IPC를 잡고 대기.
- 음성/파일 첨부 X (사진만).
- 동일 채팅 내 동시 메시지는 거부 (`/stop` 또는 종료 대기).

## 라이선스

MIT. `LICENSE` 참조.
