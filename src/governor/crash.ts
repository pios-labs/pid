/**
 * Crash-loop detector: tracks recent failure signatures per service, transitions a
 * service to "quarantined" when the same signature repeats above a threshold within
 * a configured time window.
 *
 * v0 scaffold. Real implementation lands in a follow-up commit.
 */

import type { ServiceConfig } from "../services/schema.js";

export interface FailureEvent {
	at: string;
	signature: string;
}

export class CrashDetector {
	private readonly recent = new Map<string, FailureEvent[]>();

	record(service: string, signature: string, _config: ServiceConfig): { quarantine: boolean } {
		// TODO: prepend, prune outside window, count occurrences of signature
		const list = this.recent.get(service) ?? [];
		list.unshift({ at: new Date().toISOString(), signature });
		this.recent.set(service, list);
		return { quarantine: false };
	}
}
