/**
 * pid verification extension — a REAL pi extension (NOT a fake-pi fixture).
 *
 * Purpose: drive the approval round-trip end-to-end on the real `pi` binary, exercising the OTHER
 * host→pi `send()` path (the sibling of the prompt-delivery gap that started this remediation). On
 * every bash tool call it raises a blocking UI dialog and gates execution on the answer. Under
 * `pi --mode rpc` each `ctx.ui.*` call becomes a real `extension_ui_request` on the event stream;
 * pid's approval router correlates it, enqueues it, and — when the operator runs `pid approve`/`deny`
 * — answers it over stdin with an `extension_ui_response`. On approval the bash tool proceeds; on
 * denial it is blocked. The run proves pi ACCEPTS pid's reply framing and continues.
 *
 * Comprehensive + reusable by design (per Steven): one file covers all four *blocking* dialog
 * methods, chosen by the `PID_VERIFY_UI` env var (confirm | select | input | editor; default
 * confirm), so any future checkpoint can elicit any dialog shape without new code. Mirrors pi's own
 * canonical permission gate (`examples/extensions/permission-gate.ts` — `pi.on("tool_call")` +
 * `ctx.ui.*`); nothing here is invented.
 *
 * `ctx.hasUI` is true under `pi --mode rpc` (the RPC client provides the UI — verified at
 * runner.ts:319 / 370). If it were ever false the dialog could not fire; we guard and let the run
 * surface it empirically rather than assume.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const method = (process.env.PID_VERIFY_UI ?? "confirm").toLowerCase();

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const command = String((event.input as { command?: unknown })?.command ?? "");

		if (!ctx.hasUI) return { block: true, reason: "pid-verify: no UI available to confirm" };

		let approved: boolean;
		switch (method) {
			case "select": {
				const choice = await ctx.ui.select(`pid-verify — allow bash: ${command}?`, ["approve", "deny"]);
				approved = choice === "approve";
				break;
			}
			case "input": {
				const value = await ctx.ui.input("pid-verify approval", "type 'approve' to allow");
				approved = value === "approve";
				break;
			}
			case "editor": {
				const value = await ctx.ui.editor("pid-verify approval", "approve");
				approved = (value ?? "").trim() === "approve";
				break;
			}
			default: {
				approved = await ctx.ui.confirm("pid-verify approval", `Allow bash: ${command}?`);
				break;
			}
		}

		if (!approved) return { block: true, reason: "pid-verify: blocked by operator" };
		return undefined;
	});
}
