import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAllServices } from "../src/services/loader.js";

// Every file under examples/services/ must load through the real loader —
// which enforces schema validity, name-matches-filename, and no flag conflicts.
// This keeps the shipped examples from rotting as the schema evolves.
const examplesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "examples", "services");

describe("example services", () => {
	it("every examples/services/*.yaml loads and validates cleanly", async () => {
		const { services, errors } = await loadAllServices(examplesDir);
		expect(errors).toEqual([]);
		const yamlFiles = readdirSync(examplesDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
		expect(services.length).toBe(yamlFiles.length);
	});
});
