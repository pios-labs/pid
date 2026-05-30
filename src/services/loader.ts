import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { servicesDir } from "../util/paths.js";
import { type ServiceConfig, serviceSchema, validateNoConflicts } from "./schema.js";

export interface LoadResult {
	services: ServiceConfig[];
	errors: { file: string; error: string }[];
}

export async function loadAllServices(dir: string = servicesDir()): Promise<LoadResult> {
	const services: ServiceConfig[] = [];
	const errors: { file: string; error: string }[] = [];

	let files: string[];
	try {
		files = await readdir(dir);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { services, errors };
		throw err;
	}

	for (const file of files) {
		if (extname(file) !== ".yaml" && extname(file) !== ".yml") continue;
		const path = join(dir, file);
		try {
			const text = await readFile(path, "utf8");
			const raw = parseYaml(text) as unknown;
			const parsed = serviceSchema.parse(raw);
			const stem = basename(file, extname(file));
			if (parsed.name !== stem) {
				errors.push({ file, error: `service name "${parsed.name}" does not match filename "${stem}"` });
				continue;
			}
			const conflicts = validateNoConflicts(parsed);
			if (conflicts.length > 0) {
				errors.push({ file, error: conflicts.join("\n") });
				continue;
			}
			services.push(parsed);
		} catch (err) {
			errors.push({ file, error: err instanceof Error ? err.message : String(err) });
		}
	}

	return { services, errors };
}
