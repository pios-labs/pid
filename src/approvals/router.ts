/**
 * Approval router: intercepts extension_ui_request events from supervised pi
 * subprocesses, applies per-service gate/auto_approve policy, and either replies
 * automatically or enqueues the request for human approval via the CLI.
 *
 * v0 scaffold. Real implementation lands in a follow-up commit.
 */

import type { ServiceConfig } from "../services/schema.js";

export interface ExtensionUiRequest {
	type: "extension_ui_request";
	id: string;
	method:
		| "select"
		| "confirm"
		| "input"
		| "editor"
		| "notify"
		| "setStatus"
		| "setWidget"
		| "setTitle"
		| "set_editor_text";
	[key: string]: unknown;
}

export interface PendingApproval {
	id: string;
	service: string;
	receivedAt: string;
	request: ExtensionUiRequest;
}

export type Decision =
	| { kind: "auto_approve"; value: unknown }
	| { kind: "auto_deny"; reason: string }
	| { kind: "enqueue" };

export class ApprovalRouter {
	private readonly pending = new Map<string, PendingApproval>();

	decide(_request: ExtensionUiRequest, _service: ServiceConfig): Decision {
		// TODO: pattern-match request method/args against gate and auto_approve lists
		return { kind: "enqueue" };
	}

	enqueue(service: string, request: ExtensionUiRequest): PendingApproval {
		const entry: PendingApproval = {
			id: request.id,
			service,
			receivedAt: new Date().toISOString(),
			request,
		};
		this.pending.set(request.id, entry);
		return entry;
	}

	list(): PendingApproval[] {
		return [...this.pending.values()];
	}

	resolve(id: string): PendingApproval | undefined {
		const entry = this.pending.get(id);
		if (entry) this.pending.delete(id);
		return entry;
	}
}
