/**
 * Spend caps, enforced by this runtime rather than by whichever CLI happens to
 * support a flag.
 *
 * `maxBudgetUsd` has been part of the public tool schema ("Max API spend (USD)")
 * and of council/fanout per-agent config for a long time, but the only thing it
 * ever did was append `--max-budget-usd` to the Claude Code CLI. Every other
 * engine ignored it silently, so a council of Codex agents ran with no cap at
 * all. These helpers move the decision into SessionManager, where every engine
 * passes through the same choke point.
 *
 * Accuracy caveat, deliberately surfaced rather than hidden: some engines report
 * real usage and some fall back to estimateTokens(). On the latter the cap is
 * best-effort. See skills/references/observability.md.
 */

export interface BudgetContext {
  session: string;
  engine: string;
}

/** Thrown when a session has already spent its cap and a further turn is refused. */
export class BudgetExceededError extends Error {
  readonly code = 'BUDGET_EXCEEDED';
  readonly session: string;
  readonly engine: string;
  readonly spentUsd: number;
  readonly capUsd: number;

  constructor(ctx: BudgetContext, spentUsd: number, capUsd: number) {
    super(
      `Budget exceeded for session "${ctx.session}" (${ctx.engine}): ` +
        `spent $${spentUsd.toFixed(4)} of $${capUsd.toFixed(4)} cap. ` +
        `Raise maxBudgetUsd or start a new session to continue.`,
    );
    this.name = 'BudgetExceededError';
    this.session = ctx.session;
    this.engine = ctx.engine;
    this.spentUsd = spentUsd;
    this.capUsd = capUsd;
  }
}

/**
 * True when `spentUsd` has reached `capUsd`. An absent, non-finite or
 * non-positive cap means "no cap" — a cap of 0 is treated as unset rather than
 * as "refuse everything", matching how the existing tool schema is used.
 */
export function isBudgetExceeded(spentUsd: number, capUsd: number | undefined): boolean {
  if (capUsd === undefined || capUsd === null) return false;
  if (!Number.isFinite(capUsd) || capUsd <= 0) return false;
  if (!Number.isFinite(spentUsd)) return false;
  return spentUsd >= capUsd;
}

/** Throw BudgetExceededError when the cap is already reached; otherwise return. */
export function checkBudget(spentUsd: number, capUsd: number | undefined, ctx: BudgetContext): void {
  if (isBudgetExceeded(spentUsd, capUsd)) {
    throw new BudgetExceededError(ctx, spentUsd, capUsd as number);
  }
}
