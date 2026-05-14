# Contributing to cliclaw

기여 환영합니다. 작은 fix부터 큰 기능까지 모두 가치 있습니다.

## 빠른 셋업

```bash
git clone https://github.com/choiyounggi/cliclaw.git
cd cliclaw
bun install
mkdir -p .claude/tmp        # 테스트 scratch 디렉토리
bun test                    # 222+ tests 모두 통과해야 함
bun --bun x tsc --noEmit    # 타입 에러 0건
```

## 개발 흐름

자세한 내용은 [DEVELOPMENT.md](DEVELOPMENT.md) 참조.

1. **이슈 먼저 — 큰 변경은 사전 합의**: 30줄 이상 변경 또는 새 명령/기능은 issue 또는 RFC PR로 먼저 논의.
2. **브랜치**: `git checkout -b fix/<short-desc>` 또는 `feature/<short-desc>`
3. **변경 + 테스트**: 모든 새 기능에 단위 테스트. `bun test` 통과 필수.
4. **타입체크**: `bun --bun x tsc --noEmit` 통과 필수.
5. **커밋 메시지**: 첫 줄 70자 이내 요약, 빈 줄, body는 "왜" 위주. `Co-Authored-By` 자유롭게.
6. **PR 열기**: GitHub Actions의 `Test` 워크플로가 자동 실행되어 macOS-latest에서 검증.

## 코드 컨벤션

- **런타임**: Bun 1.x (Node 21+ 호환). 외부 의존성 0개 (런타임). devDeps만.
- **TypeScript**: strict, `tsconfig.json` 기준. `any`/non-null assertion (`!`) 최소화.
- **모듈 구조**: `bot.ts`는 진입점·라우팅. 재사용 가능한 로직은 `lib/<feature>.ts` 로 분리.
- **테스트 위치**: `__tests__/<lib-module>.test.ts`. vitest API.
- **임시 파일**: `/tmp` 금지 (호스트 보안 정책). `.claude/tmp/` 사용.
- **로그/audit**: `log()` / `audit.write()` 만 사용. 직접 `console.log` 지양.
- **에러 처리**: 예측 가능한 실패는 `result.error` 로 반환, 예외는 진짜 비정상 상태일 때만.

## PR 체크리스트

- [ ] `bun test` 통과 (모든 222+ 케이스)
- [ ] `bun --bun x tsc --noEmit` 통과
- [ ] 새 기능에 단위 테스트 추가
- [ ] 변경된 행동은 README 또는 release notes에 반영
- [ ] 민감 정보 (token, 개인경로) 커밋 미포함 (`.gitignore` 확인)
- [ ] 의존성 추가 없음 (런타임 — devDeps만)

## 보안 이슈

코드 취약점·token 노출·권한 우회 등은 공개 이슈 대신 [SECURITY.md](SECURITY.md) 참조.

## 라이선스

기여하는 모든 코드는 MIT 라이선스로 배포됩니다.
