# cliclaw

세 가지 로컬 코딩 CLI(**Claude Code · Codex · Pi**)를 텔레그램에서 바꿔가며 쓸 수 있게 해주는 단일 데몬.

채팅마다 에이전트별 세션을 독립적으로 유지하고, 위험 명령에 대한 confirm 게이트와 응답 스트리밍, 이미지 첨부 처리까지 지원합니다.

## 빠른 시작 (3분)

### 1. 사전 요구사항

- macOS (Apple Silicon / Intel)
- [Bun](https://bun.sh) 1.x — `curl -fsSL https://bun.sh/install | bash`
- 사용할 코딩 CLI 중 **최소 하나** 설치 + 로그인된 상태 (봇은 인증된 자식 프로세스를 spawn할 뿐)
  - Claude Code: `npm install -g @anthropic-ai/claude-code`
  - Codex: `npm install -g @openai/codex`
  - Pi: `npm install -g @earendil-works/pi-coding-agent`

### 2. 설치

```bash
# Bun (권장)
bun add -g @younggichoi/cliclaw

# 또는 npm
npm install -g @younggichoi/cliclaw
```

> 패키지는 scoped name(`@younggichoi/cliclaw`)로 publish되지만, 설치 후 명령어는 그대로 **`cliclaw`** 입니다.

### 3. 인터랙티브 셋업

```bash
cliclaw init
```

4단계로 자동 진행됩니다:

```
Welcome to cliclaw setup.

Step 1/4 — Telegram bot token
  Get one from @BotFather (/newbot) on Telegram.
  Bot token: 1234:ABC...
  ✓ @yourbotname (id=...) verified

Step 2/4 — Detect installed coding agents
  ✓ claude  2.1.139           @ /usr/local/bin/claude
  ✓ codex   1.0.0             @ /opt/homebrew/bin/codex
  ✗ pi      not installed
  Default agent? [claude] (claude/codex): claude

Step 3/4 — Authorize your Telegram account
  Open Telegram and send any message to @yourbotname now.
  Waiting up to 5 minutes... press Ctrl-C to abort.
  ✓ Received from user_id=123456789
  Authorize this Telegram user? [Y/n] y

Step 4/4 — Auto-start at login (launchd)
  Install LaunchAgent so the bot starts automatically on login? [Y/n] y
  ✓ Installed ~/Library/LaunchAgents/com.alice.cliclaw.plist
  ✓ Bot started.

All set.
  Logs:  tail -f ~/.cliclaw/logs/bot.log
  Test:  send /status in Telegram.
```

이게 끝입니다. 맥북 화면이 꺼지거나 재부팅해도 자동으로 다시 실행됩니다.

## CLI 명령

| 명령 | 동작 |
|---|---|
| `cliclaw init` | 인터랙티브 셋업 (토큰, 에이전트 탐지, telegram id 캡처, launchd) |
| `cliclaw start` | 봇을 포그라운드로 실행 (테스트용) |
| `cliclaw install-launchd` | LaunchAgent 설치만 (이미 config.json 있을 때) |
| `cliclaw uninstall-launchd` | LaunchAgent 제거 |
| `cliclaw doctor` | 경로·에이전트·플리스트 상태 점검 |
| `cliclaw help` | 도움말 |

## 채팅 명령 (텔레그램에서)

| 명령 | 동작 |
|---|---|
| `/claude` `/codex` `/pi` | 이 채팅의 active 에이전트 전환 |
| `/status` | 모든 에이전트별 세션 상태 + 진행 중 작업 표시 |
| `/stop` | 현재 채팅의 진행 중 작업 취소 (SIGTERM → 5s 후 SIGKILL) |
| `/reset` | 현재 active 에이전트 세션만 폐기 |
| `/reset all` | 이 채팅의 모든 에이전트 세션 폐기 |
| `/safety` | 안전모드 상태 확인 — `/safety on` 또는 `/safety off` 로 토글 |
| `/start` `/help` | 도움말 |
| 그 외 텍스트 / 사진 | active 에이전트에 프롬프트 전달 (사진은 자동 다운로드 후 경로가 프롬프트 앞에 주입됨) |

에이전트 전환 시 기존 세션은 그대로 유지 — 돌아오면 이어집니다. 진행 중 작업이 있는 채팅에 새 프롬프트를 보내면 거부됩니다 (`/stop` 또는 종료 대기).

## 디렉토리 구조

설치 후 상태(state)는 `~/.cliclaw/` 에 격리됩니다:

```
~/.cliclaw/
├── config.json              # 600 권한, 토큰·화이트리스트
├── sessions.json            # 채팅별 세션 메타
├── sessions/                # 채팅별 codex / pi 디렉토리
├── workspace/               # 에이전트 공통 cwd (샌드박스)
│   └── uploads/<chatId>/    # 텔레그램 사진 다운로드
├── logs/
│   ├── bot.log
│   ├── bot.err              # launchd stderr
│   └── audit.jsonl          # 감사 로그
└── .sock/                   # confirm gate IPC
```

state 디렉토리는 `CLICLAW_HOME` 환경변수로 변경 가능합니다:

```bash
CLICLAW_HOME=~/my-bot cliclaw init
```

## 주요 기능

### 1. 에이전트 경로 자동 탐색
`config.json`에 절대경로를 박을 필요 없습니다. 시작할 때 세 단계로 자동 발견:
1. `~/.local/bin`, `~/.claude/local`, `/usr/local/bin`, `/opt/homebrew/bin`
2. `$NVM_DIR` 또는 `~/.nvm` 의 가장 최신 node 버전 `bin/<cmd>`
3. 로그인 쉘에서 `command -v <cmd>` (`.zshrc` 로드한 PATH 사용)

### 2. 위험 명령 confirm 게이트 (Claude + Codex)
Bash 도구 호출 시 PreToolUse 훅이 봇에 IPC로 질의 → 텔레그램 inline keyboard `[✅ 허용] [❌ 거부]` 표시 → 무응답 시 자동 거부.

기본 패턴: `rm -rf`, `git push --force`, DROP/TRUNCATE, `kubectl delete`, AWS `delete-*`, `sudo`, `curl|sh` 등. `confirmGate.extraPatterns` 로 사용자 정의 regex 추가 가능.

**런타임 토글** (`/safety on` · `/safety off`): 이미 본인 환경에 외부 가드(예: `pre-bash-guard`, EDR)가 있어 봇의 confirm 프롬프트가 중복으로 느껴지면 텔레그램에서 한 줄로 OFF. OFF 상태에서도 모든 IPC 요청은 audit 로그(`logs/audit.jsonl`)에 `decision: allow, reason: safety_off` 로 기록됩니다. 상태는 `$CLICLAW_HOME/safety.json` 에 영속화되어 재시작 후에도 유지.

### 3. 응답 스트리밍 (Claude)
`--include-partial-messages` 의 `text_delta` 를 받아 `editMessageText` 로 실시간 갱신. 1.5초 디바운스. 3800자 넘으면 새 메시지로 롤오버.

### 4. 이미지 첨부 처리
텔레그램의 사진/이미지 문서를 자동으로 `workspace/uploads/<chatId>/<msgId>.<ext>` 로 다운로드 후 경로를 프롬프트 앞에 추가.

### 5. headless 권한 우회
Claude는 `--permission-mode bypassPermissions` 로 실행됩니다 — Bash 위험 명령은 confirm 게이트가 잡고, 나머지 도구는 `allowedUserIds` 신뢰 경계에 위임.

### 6. 한국어 UI
모든 사용자 메시지·에러·`/help` 가 한국어.

## launchd 동작 상세

`cliclaw init` 의 4단계에서 "Yes" 를 누르면:
1. `~/Library/LaunchAgents/com.<username>.cliclaw.plist` 생성
2. `launchctl bootstrap gui/$UID <plist>` 로 즉시 적재·시작
3. 이후 로그인 / 부팅 / 크래시 시 자동 재시작
4. stdout → `~/.cliclaw/logs/bot.log`, stderr → `bot.err`

수동 관리:
```bash
# 중지 (다시 로그인 시 자동 재시작됨)
launchctl kill SIGTERM gui/$UID/com.<username>.cliclaw

# 완전 비활성화 (자동 재시작도 막음)
cliclaw uninstall-launchd

# 다시 활성화
cliclaw install-launchd
```

## 보안

- **봇 토큰 = 세 가지 CLI 모두에 대한 원격 셸**. 토큰 유출 시 BotFather `/revoke` 즉시.
- `allowedUserIds` 비면 모든 메시지 거부 (fail-closed).
- `confirmGate.enabled: false` 또는 codex sandbox 를 `danger-full-access` 로 바꾸지 말 것. 텔레그램 메시지 한 줄로 머신 전체 노출.
- `config.json` 권한 `600` 유지 (init이 자동 설정).

## 수동 셋업 (init 흐름 없이)

`cliclaw init` 을 거치지 않고 직접 설치하려면:

```bash
git clone https://github.com/choiyounggi/cliclaw.git
cd cliclaw
bun install
mkdir -p ~/.cliclaw
cp config.example.json ~/.cliclaw/config.json
chmod 600 ~/.cliclaw/config.json
# config.json 의 token, allowedUserIds 채운 뒤
bun run bot.ts
```

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
- macOS only.

## 변경 이력

버전별 변경사항은 [GitHub Releases](https://github.com/choiyounggi/cliclaw/releases) 에 정리되어 있습니다.

## 릴리스 자동화 (maintainer)

새 버전 publish 흐름:

```bash
# 1) 버전 bump (commit + tag 자동 생성)
npm version patch          # 또는 minor / major

# 2) commit + tag 푸시
git push --follow-tags

# 3) GitHub Release 발행 (CLI)
gh release create "v$(node -p 'require(\"./package.json\").version')" \
  --title "v$(node -p 'require(\"./package.json\").version')" \
  --notes "$(git log -1 --pretty=%B)"
# 또는 https://github.com/choiyounggi/cliclaw/releases/new 에서 웹 UI로 작성
```

3번 시점에 `.github/workflows/publish.yml` 이 자동 실행되어 `npm publish --access public` 까지 끝냅니다. 워크플로는 release tag 이름과 `package.json` version 일치를 먼저 검증하므로, 두 값이 어긋나 있으면 publish하지 않고 fail합니다.

**사전 등록 필요** (한 번만): repo Settings → Secrets and variables → Actions → **NPM_TOKEN** 에 npm Automation Token 등록.
1. <https://www.npmjs.com/settings/younggichoi/tokens/new> → Classic Token → **Automation** (2FA bypass 자동)
2. 발급된 `npm_…` 토큰을 GitHub Actions secret 으로 추가

## 라이선스

MIT. `LICENSE` 참조.
