import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import "@oh-my-pi/pi-coding-agent/discovery";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";

let directory = "";
let project = "";
let additional = "";
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-explicit-context-"));
	project = path.join(directory, "project");
	additional = path.join(directory, "additional");
	await fs.mkdir(project);
	await fs.mkdir(additional);
	await Bun.write(path.join(additional, "AGENTS.md"), "ADDITIONAL_AMBIENT_INSTRUCTIONS_7f3a");
	clearCache();
});
afterEach(async () => {
	clearCache();
	await fs.rm(directory, { recursive: true, force: true });
});

test("an explicit context list excludes additional-root instructions without removing multi-root tool context", async () => {
	const result = await buildSystemPrompt({
		cwd: project,
		additionalWorkspaceRoots: [additional],
		contextFiles: [{ path: path.join(project, "AGENTS.md"), content: "EXPLICIT_SELECTED_INSTRUCTIONS_7f3a" }],
		customPrompt: "",
		personality: "none",
		skills: [],
		rules: [],
		toolNames: ["read"],
		includeWorkspaceTree: false,
	});
	const rendered = result.systemPrompt.join("\n");
	expect(rendered).toContain("EXPLICIT_SELECTED_INSTRUCTIONS_7f3a");
	expect(rendered).not.toContain("ADDITIONAL_AMBIENT_INSTRUCTIONS_7f3a");
	expect(rendered).toContain(additional);
});

test("legacy discovery still includes additional-root instructions when no explicit context is supplied", async () => {
	const result = await buildSystemPrompt({
		cwd: project,
		additionalWorkspaceRoots: [additional],
		customPrompt: "",
		personality: "none",
		skills: [],
		rules: [],
		toolNames: ["read"],
		includeWorkspaceTree: false,
	});
	expect(result.systemPrompt.join("\n")).toContain("ADDITIONAL_AMBIENT_INSTRUCTIONS_7f3a");
});
