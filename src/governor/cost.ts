/**
 * Cost governor: consumes assistant message usage events, accumulates per-service spend
 * within a rolling window (daily/weekly), triggers pause/quarantine/notify when the
 * configured budget is exceeded.
 *
 * v0 scaffold. Real implementation lands in a follow-up commit.
 */

import type { ServiceConfig } from "../services/schema.js";

export interface BudgetWindow {
	service: string;
	dailyUsd?: number;
	spentUsdWindow: number;
	windowStart: string;
	windowEnd: string;
}

export type BudgetAction = "none" | "pause" | "quarantine" | "notify";

export class CostGovernor {
	private readonly windows = new Map<string, BudgetWindow>();

	observe(service: string, costUsd: number, _config: ServiceConfig): BudgetAction {
		// TODO: bucket cost into current window, persist, check threshold
		const window = this.windows.get(service);
		if (!window) return "none";
		window.spentUsdWindow += costUsd;
		// TODO: compare against config.budget.daily_usd / weekly_usd; honor config.budget.on_exceed
		return "none";
	}

	snapshot(service: string): BudgetWindow | undefined {
		return this.windows.get(service);
	}
}
