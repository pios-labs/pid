import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * Read a stream as JSONL, following pi's strict framing rules:
 * - split on \n only
 * - accept and strip a trailing \r
 * - do NOT use Node's readline (it splits on U+2028 / U+2029 which are valid inside JSON strings)
 */
export function attachJsonlReader<T = unknown>(
	stream: Readable,
	onLine: (value: T) => void,
	onError?: (err: Error, raw: string) => void,
): void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";

	stream.on("data", (chunk: Buffer | string) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) break;
			let line = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line) continue;
			try {
				onLine(JSON.parse(line) as T);
			} catch (err) {
				onError?.(err instanceof Error ? err : new Error(String(err)), line);
			}
		}
	});

	stream.on("end", () => {
		buffer += decoder.end();
		if (buffer.length === 0) return;
		const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
		if (!line) return;
		try {
			onLine(JSON.parse(line) as T);
		} catch (err) {
			onError?.(err instanceof Error ? err : new Error(String(err)), line);
		}
	});
}
