import { describe, expect, it } from "vitest";
import { parseResumeFlags } from "../src/services/resume-args.js";

describe("parseResumeFlags", () => {
	it("returns an empty spec with no flags (resume under existing caps)", () => {
		expect(parseResumeFlags({})).toEqual({ spec: {}, reset: false });
	});

	it("sets a per-dimension numeric ceiling", () => {
		expect(parseResumeFlags({ daily: "10" })).toEqual({ spec: { daily_usd: 10 }, reset: false });
		expect(parseResumeFlags({ weekly: "50.5" })).toEqual({ spec: { weekly_usd: 50.5 }, reset: false });
		expect(parseResumeFlags({ dailyTokens: "1000000" })).toEqual({ spec: { daily_tokens: 1_000_000 }, reset: false });
	});

	it('lifts a dimension with "none" (null), leaving others unset so they keep guarding', () => {
		expect(parseResumeFlags({ daily: "none" })).toEqual({ spec: { daily_usd: null }, reset: false });
	});

	it("combines independent dimensions", () => {
		expect(parseResumeFlags({ daily: "none", weekly: "100" })).toEqual({
			spec: { daily_usd: null, weekly_usd: 100 },
			reset: false,
		});
	});

	it("--unlimited lifts all dimensions", () => {
		expect(parseResumeFlags({ unlimited: true })).toEqual({
			spec: { daily_usd: null, weekly_usd: null, daily_tokens: null },
			reset: false,
		});
	});

	it("--reset returns the reset request with an empty spec", () => {
		expect(parseResumeFlags({ reset: true })).toEqual({ spec: {}, reset: true });
	});

	it("rejects --reset combined with other overrides", () => {
		expect(() => parseResumeFlags({ reset: true, unlimited: true })).toThrow(/--reset cannot be combined/);
		expect(() => parseResumeFlags({ reset: true, daily: "10" })).toThrow(/--reset cannot be combined/);
	});

	it("rejects --unlimited combined with a per-dimension limit", () => {
		expect(() => parseResumeFlags({ unlimited: true, daily: "10" })).toThrow(/--unlimited cannot be combined/);
	});

	it("rejects non-positive or non-numeric dimension values", () => {
		expect(() => parseResumeFlags({ daily: "0" })).toThrow(/--daily must be a positive number/);
		expect(() => parseResumeFlags({ daily: "-5" })).toThrow(/--daily must be a positive number/);
		expect(() => parseResumeFlags({ weekly: "abc" })).toThrow(/--weekly must be a positive number/);
	});

	it("rejects fractional token counts", () => {
		expect(() => parseResumeFlags({ dailyTokens: "1.5" })).toThrow(/--daily-tokens must be a whole number/);
	});
});
