# Development

## 필수 도구

- macOS (Apple Silicon / Intel)
- [Bun](https://bun.sh) 1.x — `curl -fsSL https://bun.sh/install | bash`
- 사용할 코딩 CLI 중 최소 하나 (claude / codex / pi / gemini) — `cliclaw doctor` 로 확인

## 로컬 dev 셋업

```bash
git clone https://github.com/choiyounggi/cliclaw.git
cd cliclaw
bun install
mkdir -p .claude/tmp

# 별도 봇 토큰 사용 권장 (운영 봇과 충돌 회피)
CLICLAW_HOME=./dev-state bun run cli.ts init

# 또는 글로벌 cliclaw 봇과 격리된 dev 모드:
CLICLAW_HOME=./dev-state bun run bot.ts
```

## 디렉토리 구조

```
.
├── bot.ts                  # 메인 데몬 (long-poll → 에이전트 dispatch → 응답)
├── cli.ts                  # cliclaw CLI 진입점 (init, doctor, upgrade, logs 등)
├── lib/
│   ├── audit-log.ts        # NDJSON 감사 로그 (rotate 통합)
│   ├── banner.ts           # ANSI Shadow 배너
│   ├── confirm-server.ts   # bash-confirm IPC 서버 (Unix socket)
│   ├── danger-patterns.ts  # 위험 명령 정규식 (안전모드 ON 시 confirm)
│   ├── hook-installer.ts   # Claude/Codex hooks + 안전모드 deny 룰 머지
│   ├── job-registry.ts     # 채팅별 진행 중 작업 + abort
│   ├── launchd.ts          # plist 생성/적재 (bootstrap race retry)
│   ├── log-rotate.ts       # 사이즈 기반 로그 로테이션 helper
│   ├── media-download.ts   # Telegram 사진 다운로드 (path traversal 방어)
│   ├── rate-limiter.ts     # 채팅별 sliding-window 제한
│   ├── resolve-cli-path.ts # claude/codex/pi/gemini 경로 자동 탐색
│   ├── setup.ts            # cliclaw init 인터랙티브 마법사
│   ├── stream-parser.ts    # Claude stream-json + Gemini stream-json 파서
│   ├── subprocess-stream.ts# Bun.spawn + abort + idle/timeout
│   ├── telegram-html.ts    # markdown → Telegram HTML
│   ├── telegram-stream.ts  # debounced editMessageText (스트리밍)
│   └── tool-indicator.ts   # tool_use 인디케이터 (디바운서)
├── bin/
│   ├── cliclaw             # bash shim — Bun으로 cli.ts 실행
│   └── bash-confirm.ts     # Claude/Codex PreToolUse hook (IPC client)
├── __tests__/              # vitest 222+ 케이스
└── samples/                # plist 샘플 등
```

## 테스트

```bash
# 전체 (Bun native test runner)
bun test

# vitest 명시적
bun --bun x vitest run

# watch 모드
bun --bun x vitest

# 단일 파일
bun test __tests__/rate-limiter.test.ts
```

새 기능에는 항상 단위 테스트. `lib/<module>.ts` ↔ `__tests__/<module>.test.ts` 매핑.

## 타입 체크

```bash
bun --bun x tsc --noEmit
```

CI에서 자동 검증. 로컬에선 IDE의 TypeScript LSP가 실시간 검출.

## 디버깅

```bash
# 봇을 foreground 로 실행 (Ctrl-C 종료)
CLICLAW_HOME=./dev-state bun run cli.ts start

# debug 로그 활성화
# config.json: "logLevel": "debug"

# 라이브 로그 추적
cliclaw logs            # bot.log
cliclaw logs --audit    # audit.jsonl
cliclaw logs --err      # bot.err

# 봇 상태 점검
cliclaw doctor
# 텔레그램에서 /health
```

## 새 에이전트 추가하기

예: "foo" CLI 통합. 다음 4 파일을 수정:

1. **`lib/resolve-cli-path.ts`**: `SupportedCli` 에 `"foo"` 추가, `wellKnownCandidates` 에 well-known 경로 추가
2. **`bot.ts`**:
   - `Agent` 유니언 + `ALL_AGENTS` 에 추가
   - `FooAgentConfig` interface + `Config.agents.foo`
   - `runFoo` adapter 함수 (`runPi` / `runGemini` 패턴 참고)
   - `runAgent` dispatcher 에 case 추가
   - `helpText` labels record 에 라벨 추가
   - 옛 config.json 자동 마이그레이션 shim에 기본값 추가
3. **`lib/setup.ts`**: `AGENTS` 배열에 추가, `writeConfig` 기본값
4. **`cli.ts`**: `cmdDoctor` 의 4-튜플에 추가
5. **`__tests__/resolve-cli-path.test.ts`**: nvm-detection 케이스 추가

## 릴리스

자세한 흐름은 README의 "릴리스 자동화" 섹션 + `.github/workflows/publish.yml` 헤더 참조. 요약:

```bash
npm version patch          # 또는 minor / major
git push --follow-tags
# 그 다음 GH UI 에서 Release publish → 워크플로 자동 npm publish
```

## 자주 묻는 질문

**Q. `bun test` 가 fresh checkout 에서 fail 한다**
A. `mkdir -p .claude/tmp` 한 번. CI 도 같은 단계 자동 수행.

**Q. 봇이 launchd 에서 안 뜬다**
A. `cliclaw logs --err` 에서 첫 에러 메시지 확인. 가장 흔한 케이스는 CA cert 누락 (회사망) — `cliclaw init` Step 4 재실행하거나 plist 의 `NODE_EXTRA_CA_CERTS` 직접 편집.

**Q. 텔레그램에서 메시지 보냈는데 응답 없음**
A. `tail -f ~/.cliclaw/logs/bot.log` 에서 `bot started: @yourbotname` 로그 확인. 그 후 입력 보내고 `msg_in` audit 이벤트가 잡히는지 확인.
