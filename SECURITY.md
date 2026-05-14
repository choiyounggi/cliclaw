# Security Policy

## 보안 보고

cliclaw 의 보안 취약점을 발견하셨다면 **공개 GitHub 이슈를 생성하지 마시고** 다음 경로로 알려주세요:

- GitHub Security Advisory: <https://github.com/choiyounggi/cliclaw/security/advisories/new>
- 또는 maintainer 에게 직접 비공개로 연락

72시간 이내에 첫 응답을 드립니다.

## 위협 모델

cliclaw 는 **단일 신뢰 사용자의 macOS 머신에서 운영**되는 봇을 가정합니다. 이 trust boundary 안에서:

- **신뢰**: 봇이 spawn 하는 4 코딩 CLI (claude / codex / pi / gemini) 및 그들의 자격증명
- **신뢰**: `allowedUserIds` 에 등록된 Telegram user_id 의 모든 입력
- **반신뢰**: 외부에서 채팅에 보낸 사진/문서 (자동 다운로드 후 path traversal 만 방어, 내용은 신뢰)
- **불신**: 익명 Telegram 메시지 (allowedUserIds 외 사용자 — 즉시 거부)

## 핵심 보안 통제

### 인증·승인
- **`allowedUserIds`**: fail-closed. 빈 배열이면 모든 메시지 거부.
- **`config.json`**: chmod 600 (init 자동). 토큰 평문 저장.

### 명령 실행 (텔레그램 → 에이전트)
- 모든 subprocess 호출이 `Bun.spawn([bin, ...args])` exec form — shell 미경유, prompt 의 shell metacharacter 무관.
- 위험 Bash 명령(`rm -rf`, `git push --force`, DROP, kubectl delete, AWS delete-*, sudo, `curl|sh`, ssh prd-* 등): `safety on` 시 텔레그램 confirm gate 로 다시 확인.
- 민감 파일 (`~/.ssh/**`, `~/.aws/**`, `.env*`, `*.pem`, `id_rsa*` 등): `safety on` 시 Claude 의 Read 도구가 거부.

### 데이터 보호
- **로그 redaction**: `bot.log` / `bot.err` 작성 전 Telegram bot token, npm token, GitHub PAT 자동 마스킹.
- **이미지 다운로드**: `workspace/uploads/<chatId>/<msgId>.<ext>` — chat-scoped, 확장자 sanitize, path traversal 방어.
- **로그 로테이션**: bot.log / audit.jsonl / bot.err 모두 size-bounded.

### 회사망 환경
- TLS 인터셉터 (Zscaler, Forticlient 등) 자동 탐지 → `cliclaw init` 의 Step 4 에서 사용자 확인 → plist의 `NODE_EXTRA_CA_CERTS` 영속화.

### Rate limiting
- 채팅별 sliding window (기본 30/min) — auto-forwarder/loop 차단.

## 권장 사용 원칙

1. **봇 토큰 = 호스트 셸 동급의 자격증명**. 유출 시 BotFather `/revoke` 즉시.
2. **`allowedUserIds` 좁게 유지**. 다른 사용자 추가는 신중히.
3. **`codex.sandbox` 를 `danger-full-access` 로 바꾸지 말 것**. 봇 토큰 하나로 호스트 전체 노출.
4. **`gemini.approvalMode: "yolo"` 옵트인 시 이해 후 결정**. 모든 도구 자동 승인 = 호스트 전체 노출.
5. **`safety off` 는 본인 환경에 외부 가드(pre-bash-guard, EDR)가 있을 때만**. 평소엔 `safety on` 유지.
6. **`config.json` 백업**: Time Machine 등 백업이 안전한 위치에 있는지 확인. 평문 토큰이 그대로 들어감.

## 알려진 한계

- 위험 패턴은 정규식 기반 — 100% 분류 불가.
- Gemini 의 위험 명령은 자체 `approvalMode` 에만 의존 (bash-confirm IPC 미통합).
- 사진 외 첨부 처리 안 함.
- macOS only — Linux/Windows 미지원.

## 검토 이력

| 날짜 | 검토자 | 결과 |
|---|---|---|
| 2026-05-14 | 내부 | Medium 3건 → v0.7.0 에서 모두 해소 (log redaction, Gemini default, Claude deny rules). 잔여 위험 모두 Low 또는 설계 의도. |
