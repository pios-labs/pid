import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * Read a stream as JSONL, following pi's strict framing rules:
 * - split on \n only
 * - accept and strip a trailing \r
 * - do NOT use Node's readline (it splits on U+2028 / U+2029 which are valid inside JSON strings)
 *
 * Returns a detach function that removes the listeners (mirrors pi's
 * `attachJsonlLineReader`). Callers detach before tearing down the sink the
 * `onLine`/`onError` callbacks write to, so a late `end`-flush can't write after close.
 */
export function attachJsonlReader<T = unknown>(
	stream: Readable,
	onLine: (value: T) => void,
	onError?: (err: Error, raw: string) => void,
): () => void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";

	const emit = (raw: string) => {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (!line) return;
		try {
			onLine(JSON.parse(line) as T);
		} catch (err) {
			onError?.(err instanceof Error ? err : new Error(String(err)), line);
		}
	};

	const onData = (chunk: Buffer | string) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) break;
			const line = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			emit(line);
		}
	};

	const onEnd = () => {
		buffer += decoder.end();
		if (buffer.length === 0) return;
		emit(buffer);
		buffer = "";
	};

	stream.on("data", onData);
	stream.on("end", onEnd);

	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}
