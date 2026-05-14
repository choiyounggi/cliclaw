# cliclaw

네 가지 로컬 코딩 CLI(**Claude Code · Codex · Pi · Gemini**)를 텔레그램에서 바꿔가며 쓸 수 있게 해주는 단일 데몬.

채팅마다 에이전트별 세션을 독립적으로 유지하고, 위험 명령에 대한 confirm 게이트, 응답 스트리밍, 이미지 첨부 처리, 회사망(Zscaler 등) TLS 인터셉터 자동 감지까지 지원합니다.

> 설치된 CLI 중 **원하는 만큼만** 깔아도 됩니다. 빠진 에이전트는 자동으로 활성 목록에서 제외됩니다.

## 빠른 시작 (3분)

### 1. 사전 요구사항

- macOS (Apple Silicon / Intel)
- [Bun](https://bun.sh) 1.x — `curl -fsSL https://bun.sh/install | bash`
- 사용할 코딩 CLI 중 **최소 하나** 설치 + 로그인된 상태 (봇은 인증된 자식 프로세스를 spawn할 뿐)
  - Claude Code: `npm install -g @anthropic-ai/claude-code`
  - Codex: `npm install -g @openai/codex`
  - Pi: `npm install -g @earendil-works/pi-coding-agent`
  - Gemini: `npm install -g @google/gemini-cli`

### 2. 설치

```bash
# Bun (권장)
bun add -g @younggichoi/cliclaw

# 또는 npm
npm install -g @younggichoi/cliclaw
```

> 패키지는 scoped name(`@younggichoi/cliclaw`)으로 publish되지만, 설치 후 명령어는 그대로 **`cliclaw`** 입니다.

### 3. 인터랙티브 셋업

```bash
cliclaw init
```

5단계로 자동 진행됩니다:

```
Welcome to cliclaw setup.

Step 1/5 — Telegram bot token
  Get one from @BotFather (/newbot) on Telegram.
  Bot token: 1234:ABC...
  ✓ @yourbotname (id=...) verified

Step 2/5 — Detect installed coding agents
  ✓ claude  2.1.139 (Claude Code)         @ ~/.nvm/.../bin/claude
  ✓ codex   1.0.0                          @ /opt/homebrew/bin/codex
  ✓ pi      unknown                        @ /opt/homebrew/bin/pi
  ✓ gemini  0.42.0                         @ ~/.nvm/.../bin/gemini
  Default agent? [claude] (claude/codex/pi/gemini): claude

Step 3/5 — Authorize your Telegram account
  Open Telegram and send any message to @yourbotname now.
  Waiting up to 5 minutes... press Ctrl-C to abort.
  ✓ Received from user_id=123456789
  Authorize this Telegram user? [Y/n] y

Step 4/5 — Corporate TLS interceptor (선택)
  $NODE_EXTRA_CA_CERTS: /path/to/Zscaler.pem
  이 CA 인증서를 봇의 LaunchAgent 환경에 적용할까요? [Y/n] y

Step 5/5 — Auto-start at login (launchd)
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
| `cliclaw init` | 인터랙티브 셋업 (토큰, 에이전트 탐지, telegram id 캡처, CA, launchd) |
| `cliclaw start` | 봇을 포그라운드로 실행 (테스트용) |
| `cliclaw install-launchd` | LaunchAgent 설치 (config.json 의 `launchd.extraEnv` 자동 반영) |
| `cliclaw uninstall-launchd` | LaunchAgent 제거 |
| `cliclaw doctor` | 경로·에이전트·플리스트 상태 점검 |
| `cliclaw help` | 도움말 |

## 채팅 명령 (텔레그램에서)

| 명령 | 동작 |
|---|---|
| `/claude` `/codex` `/pi` `/gemini` | 이 채팅의 active 에이전트 전환 (설치 안 된 에이전트는 자동 숨김) |
| `/status` | 에이전트별 세션 상태 + 진행 중 작업 표시 |
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
├── config.json              # 600 권한, 토큰·화이트리스트·launchd extraEnv
├── safety.json              # /safety on|off 영속 상태
├── sessions.json            # 채팅별 active agent 메타
├── sessions/                # 채팅별 codex / pi / gemini 디렉토리
├── workspace/               # 에이전트 공통 cwd (샌드박스)
│   ├── .claude/settings.json # 위험 명령 hook + 안전모드 ON 시 deny 룰
│   └── uploads/<chatId>/    # 텔레그램 사진 다운로드
├── logs/
│   ├── bot.log              # 토큰 자동 마스킹 적용
│   ├── bot.err              # launchd stderr
│   └── audit.jsonl          # 감사 로그 (decision, safety 상태 포함)
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

탐지 안 된 에이전트는 활성 목록에서 자동 제외됩니다 (graceful skip). 4 종 중 일부만 깔아도 봇이 정상 가동.

### 2. 안전모드 (`/safety on` · `/safety off`)
**ON (기본)**:
- 위험 Bash 명령(`rm -rf`, `git push --force`, DROP, `kubectl delete`, AWS `delete-*`, `sudo`, `curl|sh`, ssh prd-* 등)이 텔레그램 inline keyboard `[✅ 허용] [❌ 거부]` 로 다시 확인 — 무응답 시 자동 거부.
- Claude 의 Read 도구가 민감 파일 거부: `~/.ssh/**`, `~/.aws/**`, `~/.gnupg/**`, `~/.netrc`, `~/.npmrc`, `**/.env*`, `**/*.pem`, `**/id_rsa*`, `**/id_ed25519*`, `./secrets/**`.
- `confirmGate.extraPatterns` 로 사용자 정의 regex 추가 가능.

**OFF**: 이미 본인 환경에 외부 가드(`pre-bash-guard`, EDR 등)가 있어 봇의 confirm 프롬프트가 중복으로 느껴지면 텔레그램에서 한 줄로 OFF. deny 룰도 같이 비활성화. 모든 IPC 요청은 여전히 `logs/audit.jsonl` 에 `decision: allow, reason: safety_off` 로 기록됩니다.

상태는 `$CLICLAW_HOME/safety.json` 에 영속화되어 재시작 후에도 유지.

### 3. 응답 스트리밍 (Claude)
`--include-partial-messages` 의 `text_delta` 를 받아 `editMessageText` 로 실시간 갱신. 1.5초 디바운스. 3800자 넘으면 새 메시지로 롤오버.

### 4. 이미지 첨부 처리
텔레그램의 사진/이미지 문서를 자동으로 `workspace/uploads/<chatId>/<msgId>.<ext>` 로 다운로드 후 경로를 프롬프트 앞에 추가.

### 5. headless 권한 정책
- **Claude**: `--permission-mode bypassPermissions` 로 실행 — Bash 위험 명령은 confirm 게이트가 잡고, 민감 파일은 안전모드의 deny 룰이 거부.
- **Codex**: `sandbox=workspace-write` 기본. `danger-full-access` 사용 금지.
- **Pi**: 기본 모드.
- **Gemini**: `approvalMode=auto_edit` 기본 (edit 자동, 파괴적 명령은 prompt). 더 자율적 `yolo`, 더 보수적 `default`/`plan` 가능.

### 6. 회사망 TLS 인터셉터 자동 감지
Zscaler / Forticlient / Cisco Umbrella 등이 HTTPS 를 가로채는 환경이면 Node 가 Telegram 인증서를 신뢰 못 해 봇이 동작 못합니다.
`cliclaw init` 의 Step 4 가 `$NODE_EXTRA_CA_CERTS` 또는 `launchctl getenv NODE_EXTRA_CA_CERTS` 를 자동 탐지해 사용자 확인 후 `config.json` 의 `launchd.extraEnv` 에 영속화. 이후 모든 `install-launchd` 호출이 plist 에 자동 박음.

### 7. 비밀 로그 마스킹
`logs/bot.log` / `bot.err` 에 쓰이는 모든 메시지가 사전 redaction:
- Telegram bot token (`\d{8,}:[A-Za-z0-9_-]{30,}`)
- npm token (`npm_…`)
- GitHub PAT (`gh[pousr]_…`)
- live `config.token` 정확 일치

Time Machine 백업 / EDR / 어깨 너머 노출 모두 방어.

### 8. 한국어 UI
모든 사용자 메시지·에러·`/help` 가 한국어.

## launchd 동작 상세

`cliclaw init` 의 5단계에서 "Yes" 를 누르면:
1. `~/Library/LaunchAgents/com.<username>.cliclaw.plist` 생성 (corporate CA 박힘 포함)
2. `launchctl bootstrap gui/$UID <plist>` 로 즉시 적재·시작
3. 이후 로그인 / 부팅 / 크래시 시 자동 재시작
4. stdout → `~/.cliclaw/logs/bot.log`, stderr → `bot.err`

수동 관리:
```bash
# 중지 (다시 로그인 시 자동 재시작됨)
launchctl kill SIGTERM gui/$UID/com.<username>.cliclaw

# 완전 비활성화 (자동 재시작도 막음)
cliclaw uninstall-launchd

# 다시 활성화 (config.json 의 launchd.extraEnv 자동 반영)
cliclaw install-launchd
```

## 보안

- **봇 토큰 = 모든 설치된 에이전트에 대한 원격 셸**. 토큰 유출 시 BotFather `/revoke` 즉시.
- `allowedUserIds` 비면 모든 메시지 거부 (fail-closed).
- `config.json` 권한 `600` 유지 (init이 자동 설정).
- `confirmGate.enabled: false` 또는 codex sandbox 를 `danger-full-access` 로 바꾸지 말 것.
- gemini `approvalMode` 를 `yolo` 로 옵트인하면 모든 도구가 자동 승인됩니다 — 이해하고 사용.
- 의심 상황에서는 `/safety on` 으로 deny 룰 즉시 활성화.

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
- Codex / Pi / Gemini 본문 텍스트 스트리밍 미지원 (구조화 이벤트 부재 또는 미통합).
- Gemini 의 위험 명령은 자체 `approvalMode` 에만 의존 (bash-confirm IPC 미통합).
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
```

그 다음 GitHub Web UI 의 "Draft a new release" → tag 선택 → Publish release.
`.github/workflows/publish.yml` 이 자동 실행되어 `npm publish --access public` 까지 끝냅니다. 워크플로는 release tag 이름과 `package.json` version 일치를 먼저 검증하므로, 두 값이 어긋나 있으면 publish하지 않고 fail합니다.

**사전 등록 필요** (한 번만): repo Settings → Secrets and variables → Actions → **NPM_TOKEN** 에 2FA bypass 가능한 npm 토큰 등록.

1. <https://www.npmjs.com/settings/younggichoi/tokens/new>
2. Granular Access Token 또는 Classic **Automation** Token 발급 (2FA bypass 포함)
3. 발급된 `npm_…` 토큰을 GitHub Actions secret `NPM_TOKEN` 으로 추가

**보안 강화 옵션** (선택): npm Trusted Publishing(OIDC)으로 전환하면 토큰 자체가 불필요합니다.
1. <https://www.npmjs.com/package/@younggichoi/cliclaw/access> 에서 Trusted Publisher → GitHub Actions 추가 (workflow filename: `publish.yml`)
2. `.github/workflows/publish.yml` 에 `permissions: id-token: write` 추가 + `NODE_AUTH_TOKEN` 제거 + `--provenance` 플래그 추가
3. 기존 NPM_TOKEN secret 삭제

## 라이선스

MIT. `LICENSE` 참조.
