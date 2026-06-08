// Parse a captured SSE dump (from `curl -sN .../api/events`) and check for a named condition.
// Usage: node sse-check.mjs <sse-file> <snapshot|pi|budget_pause|service_exit>
// Exit 0 if the condition holds, 1 otherwise. SSE frames are blank-line-separated; each frame has
// an `event:` line and one or more `data:` lines (ADR 0011 §3 — events `snapshot` and `log`).
import { readFileSync } from "node:fs";

const [, , file, key] = process.argv;
const evs = [];
for (const block of readFileSync(file, "utf8").split(/\n{2,}/)) {
	let ev = null;
	let data = null;
	for (const line of block.split("\n")) {
		if (line.startsWith("event:")) ev = line.slice(6).trim();
		else if (line.startsWith("data:")) data = (data === null ? "" : data) + line.slice(5).trim();
	}
	if (ev && data) {
		try {
			evs.push({ ev, data: JSON.parse(data) });
		} catch {
			/* ignore a partial frame */
		}
	}
}

const checks = {
	snapshot: () => evs.some((x) => x.ev === "snapshot" && Array.isArray(x.data.services)),
	pi: () => evs.some((x) => x.ev === "log" && x.data.source === "pi"),
	budget_pause: () => evs.some((x) => x.ev === "log" && x.data.type === "pid_budget_pause"),
	service_exit: () => evs.some((x) => x.ev === "log" && x.data.type === "pid_service_exit"),
};
process.exit(checks[key]?.() ? 0 : 1);
