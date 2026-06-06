/**
 * The per-service log line format — pid's observability contract (ADR 0005).
 *
 * Every line in `logs/<name>.jsonl` shares one envelope so a reader (the `pid logs`
 * commands, and the planned dashboard) can treat pi's events and pid's own synthetic
 * events as a single ordered, replayable timeline. The envelope is the *only* place we
 * standardise names: pi's event-specific fields are preserved **verbatim** under `data`
 * (we never rename pi's shapes — see the pi cross-reference rule), and pid's synthetic
 * payloads use pi's idiom (camelCase, `toolName`).
 *
 * Envelope: `{ v, ts, service, source, type, data }`. `v` is versioned because the schema
 * is a documented public contract (see `docs/v0-spec.md` "Logging").
 */

export const LOG_SCHEMA_VERSION = 1;

export type LogSource = "pi" | "pid";

export interface LogEnvelope {
	/** Schema version — the line format is a public contract third parties parse. */
	v: number;
	/** ISO-8601 time pid wrote the line (pid stamps it; pi's stream events carry no timestamp). */
	ts: string;
	/** Originating service name (so a reader merging many services keeps provenance). */
	service: string;
	/** Who produced the payload: pi's event stream, or pid itself. */
	source: LogSource;
	/** Event type — pi's `type` verbatim, or a `pid_*` type. */
	type: string;
	/** Event-specific payload: a verbatim pi event, or a pid synthetic event's fields. */
	data: unknown;
}

function serialize(env: LogEnvelope): string {
	return `${JSON.stringify(env)}\n`;
}

/** Envelope a verbatim pi event for the log. `type` is read from the event; `data` is the event itself. */
export function formatPiEvent(service: string, event: unknown, ts: string): string {
	const type =
		event && typeof event === "object" && typeof (event as { type?: unknown }).type === "string"
			? (event as { type: string }).type
			: "unknown";
	return serialize({ v: LOG_SCHEMA_VERSION, ts, service, source: "pi", type, data: event });
}

/** Envelope a pid-synthetic event (e.g. `pid_parse_error`, `pid_approval`) for the log. */
export function formatPidEvent(service: string, type: string, data: unknown, ts: string): string {
	return serialize({ v: LOG_SCHEMA_VERSION, ts, service, source: "pid", type, data });
}

/**
 * pi stream-event types pid does NOT persist to the chronicle (ADR 0009). These are the high-frequency
 * streaming frames: `message_update` re-embeds the growing partial message on every token-chunk, and
 * `tool_execution_update` re-embeds the full accumulated tool output on every chunk — both are O(n²)
 * bytes over a message/tool, and both are redundant because the terminal `message_end` /
 * `tool_execution_end` carry the complete final content. Skipping them keeps the chronicle bounded and
 * one-line-per-real-event without losing any final state.
 */
export const STREAMING_FRAME_TYPES: ReadonlySet<string> = new Set(["message_update", "tool_execution_update"]);

/**
 * Whether a parsed pi event should be appended to the chronicle. Drops the streaming frames above;
 * keeps every lifecycle event (and anything unrecognised — we only suppress the known noise). The
 * in-process consumers still receive every event via `onServiceEvent`; only the on-disk log skips these.
 */
export function persistsToChronicle(event: unknown): boolean {
	const type = event && typeof event === "object" ? (event as { type?: unknown }).type : undefined;
	return typeof type !== "string" || !STREAMING_FRAME_TYPES.has(type);
}
