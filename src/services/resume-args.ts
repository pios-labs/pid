import type { BudgetOverrideSpec } from "../supervisor/index.js";

/**
 * Parse the `pid resume` override flags into the daemon request shape (ADR 0002, decision 5).
 * Pure and side-effect-free so it can be unit-tested without the CLI or a daemon.
 *
 * Each dimension flag takes a non-negative number (new ceiling for the current window) or the
 * literal `none` (lift that cap — unlimited this window). `--unlimited` lifts all dimensions;
 * `--reset` zeroes the current windows under the original caps. Conflicting combinations are
 * rejected so the user gets a clear error instead of a surprising precedence rule.
 */

export interface ResumeFlags {
	daily?: string;
	weekly?: string;
	dailyTokens?: string;
	unlimited?: boolean;
	reset?: boolean;
}

export interface ResumeRequest {
	spec: BudgetOverrideSpec;
	reset: boolean;
}

/** A dimension value: a number sets the ceiling, `null` lifts the cap (from the literal `none`). */
function parseDimension(flag: string, raw: string, integer: boolean): number | null {
	if (raw === "none") return null;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${flag} must be a positive number or "none" (got "${raw}")`);
	}
	if (integer && !Number.isInteger(value)) {
		throw new Error(`${flag} must be a whole number of tokens or "none" (got "${raw}")`);
	}
	return value;
}

export function parseResumeFlags(flags: ResumeFlags): ResumeRequest {
	const hasDimension = flags.daily !== undefined || flags.weekly !== undefined || flags.dailyTokens !== undefined;

	if (flags.reset && (flags.unlimited || hasDimension)) {
		throw new Error("--reset cannot be combined with --unlimited or per-dimension limits");
	}
	if (flags.unlimited && hasDimension) {
		throw new Error("--unlimited cannot be combined with per-dimension limits");
	}

	if (flags.reset) return { spec: {}, reset: true };
	if (flags.unlimited) return { spec: { daily_usd: null, weekly_usd: null, daily_tokens: null }, reset: false };

	const spec: BudgetOverrideSpec = {};
	if (flags.daily !== undefined) spec.daily_usd = parseDimension("--daily", flags.daily, false);
	if (flags.weekly !== undefined) spec.weekly_usd = parseDimension("--weekly", flags.weekly, false);
	if (flags.dailyTokens !== undefined) spec.daily_tokens = parseDimension("--daily-tokens", flags.dailyTokens, true);
	return { spec, reset: false };
}
