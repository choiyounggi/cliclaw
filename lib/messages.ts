/**
 * Typed en/ko message table for every user-facing Telegram string.
 * `config.locale` selects the table at boot (see bot.ts). The `Messages`
 * interface makes en/ko parity a compile-time guarantee — both `EN` and
 * `KO` must implement every member.
 */

export type Locale = "en" | "ko";

export interface ConfirmMessageParams {
  agent: string;
  patternId: string;
  reason: string;
  command: string;
  justification?: string;
}

export interface StatusAgentRow {
  agent: string;
  hasSession: boolean;
  mode: string;
  /** Pre-formatted, language-neutral duration (e.g. "30m", "—") — see fmtMs(). */
  timeoutStr: string;
  idleStr: string;
  turnCount?: number;
  sessionIdShort?: string;
  lastUsedAt?: string;
}

export interface StatusParams {
  activeAgent: string;
  rows: StatusAgentRow[];
  inProgress: { agent: string; elapsedSec: number } | null;
  /** null when the confirm gate is OFF (config); omit the line entirely. */
  confirmGatePending: number | null;
}

export interface HealthParams {
  uptime: string;
  rss: string;
  heap: string;
  agentNames: string[];
  totalAgents: number;
  activeChats: number;
  inFlight: number;
  logSize: string;
  auditSize: string;
  errSize: string;
  safetyLabel: string;
  /** null when the confirm gate is OFF (config). */
  confirmPending: number | null;
}

export interface HelpParams {
  active: string;
  agentNames: string[];
  cwd: string;
  safetyLabel: string;
  streamingLabel: string;
}

export interface AgentModeLabelParams {
  confirmGateEnabled: boolean;
  safetyEnabled: boolean;
  codexSandbox: string;
  geminiApprovalMode: string;
}

export interface Messages {
  // ---------- chat policy / auth / rate limit ----------
  groupChatOnly: string;
  unauthorizedWithId(userId: number): string;
  unauthorized: string;
  rateLimited(seconds: number): string;

  // ---------- media ----------
  attachmentDownloadFailed(err: string): string;
  defaultImagePrompt: string;
  imageAttachmentNote(refs: string): string;

  // ---------- help / status / health ----------
  helpText(params: HelpParams): string;
  agentLabel(agent: string): string;
  statusText(params: StatusParams): string;
  healthText(params: HealthParams): string;
  unknownCommand(cmdText: string, help: string): string;

  // ---------- agent switching / sessions ----------
  switchedAgent(agent: string, resumeTurnCount: number | null): string;
  resetAllDone: string;
  resetAgentDone(agent: string): string;
  autoResetTurns(agent: string, maxTurns: number): string;

  // ---------- job lifecycle ----------
  stopCancelled(agent: string, elapsedSec: number): string;
  noJobInProgress: string;
  jobInProgressLock(agent: string, elapsedSec: number): string;
  jobAlreadyRegistered(agent: string): string;
  agentError(agent: string, error: string): string;
  agentReply(agent: string, text: string): string;
  emptyResponse: string;
  internalError(message: string): string;

  // ---------- agent adapter errors ----------
  userStoppedError: string;
  timeoutError(timeoutMs: number): string;
  idleTimeoutError(idleTimeoutMs: number | undefined): string;

  // ---------- agent mode / safety toggle ----------
  agentModeLabel(agent: string, params: AgentModeLabelParams): string;
  safetyDisabledLabel: string;
  safetyDisabledNotice: string;
  safetyStatusDetailOn: string;
  safetyStatusDetailOff: string;
  safetyStatusMessage(state: "ON" | "OFF", detail: string): string;
  safetyAlreadyOn: string;
  safetyAlreadyOff: string;
  safetyOnNotice: string;
  safetyOffNotice: string;
  safetyUsage: string;

  // ---------- confirm gate ----------
  confirmMessageText(req: ConfirmMessageParams): string;
  confirmOutcomeText(decision: "allow" | "deny", reason?: string): string;
  confirmAllowButton: string;
  confirmDenyButton: string;
  confirmReasonSafetyOff: string;
  confirmReasonForbidden(why: string): string;
  confirmReasonPromptFailed: string;
  forbiddenCommandNotice(patternId: string, why: string, cmd: string): string;
  callbackUnauthorized: string;
  callbackInvalid: string;
  callbackAllowed: string;
  callbackDenied: string;
  callbackExpired: string;

  // ---------- shutdown ----------
  shutdownRestartNotice: string;

  // ---------- Telegram command menu (setMyCommands) ----------
  commandDescAgent(agent: string): string;
  commandDescStatus: string;
  commandDescReset: string;
  commandDescHealth: string;
  commandDescStop: string;
  commandDescSafety: string;
  commandDescHelp: string;
}

function statusTmoLineKo(row: StatusAgentRow): string {
  const tmo = `타임아웃=${row.timeoutStr} / 무활동=${row.idleStr}`;
  if (!row.hasSession) {
    return `${row.agent}: (세션 없음)  모드: ${row.mode}  ${tmo}`;
  }
  return [
    `${row.agent}: 턴=${row.turnCount} 세션=${row.sessionIdShort} 마지막=${row.lastUsedAt}`,
    `  모드: ${row.mode}  ${tmo}`,
  ].join("\n");
}

const KO: Messages = {
  groupChatOnly: "이 봇은 1:1 채팅에서만 동작합니다. 그룹에서는 사용할 수 없어요.",
  unauthorizedWithId: (userId) =>
    `권한이 없습니다. 본인 user_id=${userId}\n관리자에게 화이트리스트 등록을 요청하세요.`,
  unauthorized: "권한이 없습니다.",
  rateLimited: (seconds) => `⏳ 너무 빠릅니다. ${seconds}초 후 다시 시도해주세요.`,

  attachmentDownloadFailed: (err) => `⚠️ 첨부 다운로드 실패: ${err}`,
  defaultImagePrompt: "첨부 이미지를 분석해줘.",
  imageAttachmentNote: (refs) => `\n\n[첨부 이미지 — Read 도구로 열어 분석할 것]\n${refs}`,

  helpText: (p) =>
    [
      "🤖 로컬 멀티에이전트 봇",
      "",
      `현재 에이전트: ${p.active}`,
      "",
      "에이전트 전환:",
      ...p.agentNames.map((a) => KO.agentLabel(a)),
      "",
      "세션 명령:",
      "  /reset      — 현재 에이전트 세션 초기화",
      "  /reset all  — 이 채팅의 모든 에이전트 세션 초기화",
      "  /status     — 에이전트별 세션 상태 + 진행 중 작업 표시",
      "  /health     — 봇 헬스 (가동시간, 메모리, 로그 크기)",
      "  /stop       — 진행 중 작업 취소",
      "  /safety     — 안전모드 상태 (/safety on · off로 토글)",
      "  /help       — 이 도움말",
      "",
      `작업 디렉토리: ${p.cwd}`,
      `안전모드: ${p.safetyLabel}`,
      `스트리밍: ${p.streamingLabel}`,
    ].join("\n"),
  agentLabel: (agent) => {
    const labels: Record<string, string> = {
      claude: "  /claude  — Anthropic Claude Code",
      codex: "  /codex   — OpenAI Codex",
      pi: "  /pi      — Pi Coding Agent",
      gemini: "  /gemini  — Google Gemini CLI",
    };
    return labels[agent] ?? `  /${agent}`;
  },
  statusText: (p) => {
    const lines = [`현재: ${p.activeAgent}`, ""];
    for (const row of p.rows) {
      lines.push(statusTmoLineKo(row));
    }
    if (p.inProgress) {
      lines.push("", `🏃 진행 중: ${p.inProgress.agent} (${p.inProgress.elapsedSec}초) — /stop 으로 취소`);
    }
    if (p.confirmGatePending !== null) {
      lines.push("", `위험명령 확인 게이트: ON, 대기중=${p.confirmGatePending}`);
    }
    return lines.join("\n");
  },
  healthText: (p) => {
    const lines = [
      "🩺 cliclaw 헬스",
      "",
      `가동시간: ${p.uptime}`,
      `메모리: RSS ${p.rss}, heap ${p.heap}`,
      `에이전트 활성: ${p.agentNames.join(", ")} (총 ${p.agentNames.length}/${p.totalAgents})`,
      `활성 채팅: ${p.activeChats}`,
      `진행 중 작업: ${p.inFlight}`,
      "",
      "로그:",
      `  bot.log    ${p.logSize}`,
      `  audit.json ${p.auditSize}`,
      `  bot.err    ${p.errSize}`,
      "",
      `안전모드: ${p.safetyLabel}`,
      p.confirmPending !== null
        ? `위험명령 게이트 대기: ${p.confirmPending}`
        : "위험명령 게이트: OFF (config)",
    ];
    return lines.join("\n");
  },
  unknownCommand: (cmdText, help) => `알 수 없는 명령: ${cmdText}\n\n${help}`,

  switchedAgent: (agent, resumeTurnCount) => {
    const tail = resumeTurnCount !== null ? ` (이어가기, ${resumeTurnCount}턴)` : " (새 세션)";
    return `✅ ${agent}로 전환됨${tail}`;
  },
  resetAllDone: "🧹 이 채팅의 모든 에이전트 세션을 초기화했습니다.",
  resetAgentDone: (agent) => `🧹 ${agent} 세션을 초기화했습니다.`,
  autoResetTurns: (agent, maxTurns) =>
    `🧹 [${agent}] ${maxTurns}턴 도달 — 세션 자동 초기화. 이전 컨텍스트는 사라집니다.`,

  stopCancelled: (agent, elapsedSec) => `🛑 [${agent}] ${elapsedSec}초 경과 — 중지 중…`,
  noJobInProgress: "ℹ️ 진행 중인 작업이 없습니다.",
  jobInProgressLock: (agent, elapsedSec) =>
    `⏳ [${agent}] 작업 진행 중 (${elapsedSec}초). /stop 으로 취소하거나 종료를 기다리세요.`,
  jobAlreadyRegistered: (agent) => `⏳ [${agent}] 작업 진행 중. /stop 으로 취소하세요.`,
  agentError: (agent, error) => `⚠️ [${agent}] ${error}`,
  agentReply: (agent, text) => `[${agent}] ${text}`,
  emptyResponse: "(빈 응답)",
  internalError: (message) => `⚠️ 내부 오류: ${message}`,

  userStoppedError: "사용자가 중지함",
  timeoutError: (timeoutMs) => `타임아웃 (${timeoutMs}ms 초과)`,
  idleTimeoutError: (idleTimeoutMs) => `무활동 타임아웃 (${idleTimeoutMs}ms)`,

  agentModeLabel: (agent, p) => {
    const safetyTag = p.safetyEnabled ? " + 안전모드 ON" : "";
    if (agent === "claude") return p.confirmGateEnabled ? `헤드리스${safetyTag}` : "헤드리스";
    if (agent === "codex") return `sandbox=${p.codexSandbox}${p.confirmGateEnabled ? safetyTag : ""}`;
    if (agent === "pi") return "기본";
    if (agent === "gemini") return `approvalMode=${p.geminiApprovalMode} — confirm 게이트 미적용`;
    return "?";
  },
  safetyDisabledLabel: "비활성 (config)",
  safetyDisabledNotice:
    "안전모드는 이 설치본에서 비활성화되어 있습니다 (config.confirmGate.enabled=false).\n" +
    "다시 활성화하려면 config.json을 수정하고 봇을 재시작하세요.",
  safetyStatusDetailOn:
    "위험 Bash 명령은 텔레그램 confirm 으로 다시 묻고, Claude 의 Read 도구가 ~/.ssh · ~/.aws · .env · *.pem · id_rsa 등 민감 파일을 차단합니다.",
  safetyStatusDetailOff:
    "모든 Bash 명령이 즉시 실행되고, 민감 파일 deny 룰도 비활성화됩니다. 본인 환경의 외부 가드(pre-bash-guard, EDR 등)에 위임된 상태입니다.",
  safetyStatusMessage: (state, detail) => `🛡 안전모드: ${state}\n${detail}\n\n사용: /safety on · /safety off`,
  safetyAlreadyOn: "🛡 안전모드는 이미 ON 입니다.",
  safetyAlreadyOff: "🛡 안전모드는 이미 OFF 입니다.",
  safetyOnNotice:
    "🛡 안전모드 ON.\n" +
    "• 위험 Bash 명령은 텔레그램 confirm 으로 다시 묻습니다.\n" +
    "• Claude 의 Read 도구가 ~/.ssh, ~/.aws, .env, *.pem, id_rsa 등 민감 파일을 차단합니다.",
  safetyOffNotice:
    "🛡 안전모드 OFF. Bash 게이트 + 민감 파일 deny 룰이 비활성화됩니다.\n" +
    "본인 환경의 외부 가드(pre-bash-guard, EDR 등)가 위험 명령을 차단하는지 확인하세요.",
  safetyUsage: "사용: /safety · /safety on · /safety off",

  confirmMessageText: (req) => {
    const truncated = req.command.length > 800 ? req.command.slice(0, 800) + "…" : req.command;
    return [
      "⚠️ 위험 명령 확인",
      "",
      `에이전트: ${req.agent}`,
      `패턴: ${req.patternId} — ${req.reason}`,
      ...(req.justification ? ["", `이유: ${req.justification}`] : []),
      "",
      "명령:",
      truncated,
    ].join("\n");
  },
  confirmOutcomeText: (decision, reason) => {
    if (decision === "allow") return "✅ 허용됨";
    return reason ? `❌ 거부됨: ${reason}` : "❌ 거부됨";
  },
  confirmAllowButton: "✅ 허용",
  confirmDenyButton: "❌ 거부",
  confirmReasonSafetyOff: "안전모드 OFF (사용자 환경의 외부 가드에 위임)",
  confirmReasonForbidden: (why) => `정책상 거부: ${why}`,
  confirmReasonPromptFailed: "사용자에게 프롬프트를 띄우지 못함",
  forbiddenCommandNotice: (patternId, why, cmd) =>
    `🛑 정책상 거부된 명령 — pattern=${patternId}\n사유: ${why}\n\n명령:\n${cmd}`,
  callbackUnauthorized: "권한 없음",
  callbackInvalid: "잘못된 콜백",
  callbackAllowed: "허용",
  callbackDenied: "거부",
  callbackExpired: "이미 만료됨",

  shutdownRestartNotice: "⚠️ 봇이 재시작됩니다 — 진행 중이던 작업이 중단되었습니다. 다시 보내주세요.",

  commandDescAgent: (agent) => `${agent} 에이전트로 전환`,
  commandDescStatus: "에이전트별 세션 상태",
  commandDescReset: "현재 에이전트 세션 초기화",
  commandDescHealth: "봇 헬스 (가동시간/메모리)",
  commandDescStop: "진행 중 작업 취소",
  commandDescSafety: "안전모드 상태/토글",
  commandDescHelp: "도움말",
};

const EN: Messages = {
  groupChatOnly: "This bot only works in 1:1 chats. It can't be used in groups.",
  unauthorizedWithId: (userId) =>
    `You are not authorized. Your user_id=${userId}\nAsk the admin to add you to the whitelist.`,
  unauthorized: "You are not authorized.",
  rateLimited: (seconds) => `⏳ Too fast. Try again in ${seconds}s.`,

  attachmentDownloadFailed: (err) => `⚠️ Attachment download failed: ${err}`,
  defaultImagePrompt: "Analyze the attached image.",
  imageAttachmentNote: (refs) => `\n\n[Attached images — open with the Read tool to analyze]\n${refs}`,

  helpText: (p) =>
    [
      "🤖 Local multi-agent bot",
      "",
      `Current agent: ${p.active}`,
      "",
      "Switch agent:",
      ...p.agentNames.map((a) => EN.agentLabel(a)),
      "",
      "Session commands:",
      "  /reset      — reset the current agent's session",
      "  /reset all  — reset every agent session for this chat",
      "  /status     — per-agent session state + in-progress job",
      "  /health     — bot health (uptime, memory, log size)",
      "  /stop       — cancel the in-progress job",
      "  /safety     — safety mode status (toggle with /safety on · off)",
      "  /help       — this help",
      "",
      `Working directory: ${p.cwd}`,
      `Safety mode: ${p.safetyLabel}`,
      `Streaming: ${p.streamingLabel}`,
    ].join("\n"),
  agentLabel: (agent) => {
    const labels: Record<string, string> = {
      claude: "  /claude  — Anthropic Claude Code",
      codex: "  /codex   — OpenAI Codex",
      pi: "  /pi      — Pi Coding Agent",
      gemini: "  /gemini  — Google Gemini CLI",
    };
    return labels[agent] ?? `  /${agent}`;
  },
  statusText: (p) => {
    const lines = [`Current: ${p.activeAgent}`, ""];
    for (const row of p.rows) {
      lines.push(statusTmoLineEn(row));
    }
    if (p.inProgress) {
      lines.push("", `🏃 In progress: ${p.inProgress.agent} (${p.inProgress.elapsedSec}s) — /stop to cancel`);
    }
    if (p.confirmGatePending !== null) {
      lines.push("", `Dangerous-command confirm gate: ON, pending=${p.confirmGatePending}`);
    }
    return lines.join("\n");
  },
  healthText: (p) => {
    const lines = [
      "🩺 cliclaw health",
      "",
      `Uptime: ${p.uptime}`,
      `Memory: RSS ${p.rss}, heap ${p.heap}`,
      `Active agents: ${p.agentNames.join(", ")} (${p.agentNames.length}/${p.totalAgents} total)`,
      `Active chats: ${p.activeChats}`,
      `Jobs in flight: ${p.inFlight}`,
      "",
      "Logs:",
      `  bot.log    ${p.logSize}`,
      `  audit.json ${p.auditSize}`,
      `  bot.err    ${p.errSize}`,
      "",
      `Safety mode: ${p.safetyLabel}`,
      p.confirmPending !== null
        ? `Dangerous-command gate pending: ${p.confirmPending}`
        : "Dangerous-command gate: OFF (config)",
    ];
    return lines.join("\n");
  },
  unknownCommand: (cmdText, help) => `Unknown command: ${cmdText}\n\n${help}`,

  switchedAgent: (agent, resumeTurnCount) => {
    const tail = resumeTurnCount !== null ? ` (resumed, ${resumeTurnCount} turns)` : " (new session)";
    return `✅ Switched to ${agent}${tail}`;
  },
  resetAllDone: "🧹 Reset every agent session for this chat.",
  resetAgentDone: (agent) => `🧹 Reset the ${agent} session.`,
  autoResetTurns: (agent, maxTurns) =>
    `🧹 [${agent}] reached ${maxTurns} turns — session auto-reset. Prior context is gone.`,

  stopCancelled: (agent, elapsedSec) => `🛑 [${agent}] ${elapsedSec}s elapsed — cancelling…`,
  noJobInProgress: "ℹ️ No job in progress.",
  jobInProgressLock: (agent, elapsedSec) =>
    `⏳ [${agent}] job in progress (${elapsedSec}s). Use /stop to cancel or wait for it to finish.`,
  jobAlreadyRegistered: (agent) => `⏳ [${agent}] job in progress. Use /stop to cancel.`,
  agentError: (agent, error) => `⚠️ [${agent}] ${error}`,
  agentReply: (agent, text) => `[${agent}] ${text}`,
  emptyResponse: "(empty response)",
  internalError: (message) => `⚠️ Internal error: ${message}`,

  userStoppedError: "Stopped by user",
  timeoutError: (timeoutMs) => `Timeout (exceeded ${timeoutMs}ms)`,
  idleTimeoutError: (idleTimeoutMs) => `Idle timeout (${idleTimeoutMs}ms)`,

  agentModeLabel: (agent, p) => {
    const safetyTag = p.safetyEnabled ? " + safety mode ON" : "";
    if (agent === "claude") return p.confirmGateEnabled ? `headless${safetyTag}` : "headless";
    if (agent === "codex") return `sandbox=${p.codexSandbox}${p.confirmGateEnabled ? safetyTag : ""}`;
    if (agent === "pi") return "default";
    if (agent === "gemini") return `approvalMode=${p.geminiApprovalMode} — confirm gate not applied`;
    return "?";
  },
  safetyDisabledLabel: "disabled (config)",
  safetyDisabledNotice:
    "Safety mode is disabled for this install (config.confirmGate.enabled=false).\n" +
    "To re-enable it, edit config.json and restart the bot.",
  safetyStatusDetailOn:
    "Dangerous Bash commands prompt again via Telegram confirm, and Claude's Read tool blocks sensitive files like ~/.ssh · ~/.aws · .env · *.pem · id_rsa.",
  safetyStatusDetailOff:
    "Every Bash command runs immediately and the sensitive-file deny rules are also disabled. You're relying on your own environment's external guards (pre-bash-guard, EDR, etc.).",
  safetyStatusMessage: (state, detail) => `🛡 Safety mode: ${state}\n${detail}\n\nUsage: /safety on · /safety off`,
  safetyAlreadyOn: "🛡 Safety mode is already ON.",
  safetyAlreadyOff: "🛡 Safety mode is already OFF.",
  safetyOnNotice:
    "🛡 Safety mode ON.\n" +
    "• Dangerous Bash commands prompt again via Telegram confirm.\n" +
    "• Claude's Read tool blocks sensitive files like ~/.ssh, ~/.aws, .env, *.pem, id_rsa.",
  safetyOffNotice:
    "🛡 Safety mode OFF. The Bash gate and sensitive-file deny rules are disabled.\n" +
    "Make sure your own environment's external guards (pre-bash-guard, EDR, etc.) catch dangerous commands.",
  safetyUsage: "Usage: /safety · /safety on · /safety off",

  confirmMessageText: (req) => {
    const truncated = req.command.length > 800 ? req.command.slice(0, 800) + "…" : req.command;
    return [
      "⚠️ Dangerous command confirmation",
      "",
      `Agent: ${req.agent}`,
      `Pattern: ${req.patternId} — ${req.reason}`,
      ...(req.justification ? ["", `Reason: ${req.justification}`] : []),
      "",
      "Command:",
      truncated,
    ].join("\n");
  },
  confirmOutcomeText: (decision, reason) => {
    if (decision === "allow") return "✅ Allowed";
    return reason ? `❌ Denied: ${reason}` : "❌ Denied";
  },
  confirmAllowButton: "✅ Allow",
  confirmDenyButton: "❌ Deny",
  confirmReasonSafetyOff: "Safety mode OFF (delegated to the user's external guards)",
  confirmReasonForbidden: (why) => `Denied by policy: ${why}`,
  confirmReasonPromptFailed: "Failed to prompt the user",
  forbiddenCommandNotice: (patternId, why, cmd) =>
    `🛑 Command denied by policy — pattern=${patternId}\nReason: ${why}\n\nCommand:\n${cmd}`,
  callbackUnauthorized: "Not authorized",
  callbackInvalid: "Invalid callback",
  callbackAllowed: "Allowed",
  callbackDenied: "Denied",
  callbackExpired: "Already expired",

  shutdownRestartNotice: "⚠️ The bot is restarting — the in-progress job was interrupted. Please resend it.",

  commandDescAgent: (agent) => `Switch to the ${agent} agent`,
  commandDescStatus: "Per-agent session state",
  commandDescReset: "Reset the current agent's session",
  commandDescHealth: "Bot health (uptime/memory)",
  commandDescStop: "Cancel the in-progress job",
  commandDescSafety: "Safety mode status/toggle",
  commandDescHelp: "Help",
};

function statusTmoLineEn(row: StatusAgentRow): string {
  const tmo = `timeout=${row.timeoutStr} / idle=${row.idleStr}`;
  if (!row.hasSession) {
    return `${row.agent}: (no session)  mode: ${row.mode}  ${tmo}`;
  }
  return [
    `${row.agent}: turns=${row.turnCount} session=${row.sessionIdShort} last=${row.lastUsedAt}`,
    `  mode: ${row.mode}  ${tmo}`,
  ].join("\n");
}

export function getMessages(locale?: string): Messages {
  if (locale === "en") return EN;
  if (locale === "ko") return KO;
  if (locale === undefined) return KO;
  return EN;
}
