/**
 * Danger pattern matcher for the Telegram confirm gate.
 *
 * These patterns identify commands that warrant remote confirmation when the
 * user is operating the bot away from the keyboard. They INTENTIONALLY OVERLAP
 * with the user's existing pre-bash-guard hooks — those auto-block, this asks.
 * If the user's auto-block fires first the confirm gate never runs (which is
 * the safer default).
 *
 * Patterns derived from ~/.codex/hooks/pre-bash-guard.sh and the user's
 * CLAUDE.md security policy.
 */

export interface DangerPattern {
  /** Stable id used in audit log + Telegram message. */
  id: string;
  /** Regex applied to the raw command string. */
  re: RegExp;
  /** Short reason shown to the operator on Telegram. */
  reason: string;
}

export const DEFAULT_DANGER_PATTERNS: readonly DangerPattern[] = [
  // ── Filesystem destruction ──
  {
    id: "rm-rf",
    re: /(^|[\s;|&])rm\s+(-[a-zA-Z]*[rR][a-zA-Z]*[fF]|-[a-zA-Z]*[fF][a-zA-Z]*[rR]|--recursive\s+--force|--force\s+--recursive)\b/,
    reason: "rm -rf 계열 — 재귀 강제 삭제",
  },
  {
    id: "dd-mkfs",
    re: /\b(dd\s+if=.*of=\/dev\/|mkfs\.[a-z0-9]+\s+\/dev\/)/,
    reason: "디스크 직접 쓰기 (dd / mkfs)",
  },
  {
    id: "redirect-to-dev",
    // Only real block devices. /dev/null, /dev/zero, /dev/random, /dev/tty,
    // /dev/stdout, /dev/stderr are legitimate redirect targets every shell
    // session touches dozens of times. The prior alternation included
    // `null$` which matched the trailing `/dev/null` in `cmd 2>/dev/null`,
    // routing nearly every common command through the confirm gate and
    // causing 5-minute timeouts on the Telegram client.
    re: />\s*\/dev\/(sd[a-z]|nvme\d|hd[a-z]|disk\d|mmcblk\d|loop\d)/i,
    reason: "디스크 디바이스 직접 리다이렉션",
  },

  // ── Git destructive ──
  {
    id: "git-push-force",
    re: /\bgit\s+push\s+(-f\b|--force\b|--force-with-lease\b)/,
    reason: "git push --force",
  },
  {
    id: "git-reset-hard",
    re: /\bgit\s+reset\s+--hard\b/,
    reason: "git reset --hard",
  },
  {
    id: "git-clean-force",
    re: /\bgit\s+clean\s+(-[a-zA-Z]*f|.*--force)/,
    reason: "git clean -f",
  },
  {
    id: "git-branch-delete",
    re: /\bgit\s+branch\s+(-D\b|--delete\s+--force)/,
    reason: "git branch -D",
  },

  // ── DB destructive ──
  {
    id: "sql-drop",
    re: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA|INDEX)\b/i,
    reason: "DROP / TRUNCATE",
  },
  {
    id: "sql-delete-all",
    re: /\bDELETE\s+FROM\s+\w+(\s*;?\s*$|\s+(LIMIT|RETURNING|;))/i,
    reason: "DELETE FROM (WHERE 절 누락 가능)",
  },
  {
    id: "sql-update-all",
    re: /\bUPDATE\s+\w+\s+SET\s+[^;]+(?<!WHERE\b[^;]*)(;|$)/i,
    reason: "UPDATE ... SET (WHERE 절 누락 가능)",
  },

  // ── Cloud destructive ──
  {
    id: "kubectl-delete",
    re: /\bkubectl\s+delete\b/,
    reason: "kubectl delete",
  },
  {
    id: "aws-destructive",
    re: /\baws\s+(rds\s+(delete|reboot)|s3\s+rb|s3api\s+delete-bucket|ec2\s+(terminate|stop)-instances|iam\s+delete-(user|role|policy|access-key)|cloudformation\s+delete-stack|eks\s+delete-cluster|elasticache\s+delete|secretsmanager\s+delete-secret)/,
    reason: "AWS 리소스 삭제/중지",
  },
  {
    id: "docker-prune",
    re: /\bdocker\s+(system\s+prune|volume\s+prune|image\s+prune|container\s+prune)\b/,
    reason: "docker prune",
  },

  // ── Privilege escalation ──
  {
    id: "sudo",
    re: /(^|[\s;|&])sudo\b/,
    reason: "sudo 사용",
  },

  // ── Supply chain ──
  {
    id: "curl-pipe-shell",
    re: /\b(curl|wget|fetch)\s+[^|]*\|\s*(sh|bash|zsh|python3?|node)\b/,
    reason: "curl | sh 류 원격 스크립트 직접 실행",
  },

  // ── SSH to prod ──
  {
    id: "ssh-prd",
    re: /\bssh\s+\S*(prd|prod|production)\S*/i,
    reason: "운영 환경 SSH 접속",
  },

  // ── Secret exposure ──
  {
    id: "export-secret",
    re: /\bexport\s+(AWS_SECRET|AWS_SESSION_TOKEN|GITHUB_TOKEN|SLACK_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|TELEGRAM_BOT_TOKEN)/,
    reason: "비밀 환경변수 export (히스토리 노출)",
  },

  // ── Process termination ──
  {
    id: "killall",
    re: /\b(killall|pkill)\s+(-9\s+)?\S+/,
    reason: "프로세스 일괄 종료",
  },
];

/** Compile user-supplied regex strings, returns [valid patterns, invalid sources]. */
export function compileExtraPatterns(sources: readonly string[]): {
  patterns: DangerPattern[];
  invalid: { source: string; error: string }[];
} {
  const patterns: DangerPattern[] = [];
  const invalid: { source: string; error: string }[] = [];
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    try {
      patterns.push({
        id: `extra-${i}`,
        re: new RegExp(src),
        reason: `사용자 정의 패턴 #${i}`,
      });
    } catch (err) {
      invalid.push({ source: src, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { patterns, invalid };
}

/** Returns the first matching pattern, or null. */
export function matchDanger(
  command: string,
  patterns: readonly DangerPattern[] = DEFAULT_DANGER_PATTERNS,
): DangerPattern | null {
  if (!command) return null;
  for (const p of patterns) {
    if (p.re.test(command)) return p;
  }
  return null;
}
