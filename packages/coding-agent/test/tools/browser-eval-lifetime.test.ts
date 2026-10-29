import { afterAll, afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	disposeVmContextsByOwner,
	executeInVmContext,
} from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { executeJs } from "@oh-my-pi/pi-coding-agent/eval/js/executor";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { holdBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { getTab, releaseTab, type WorkerTabSession } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const fixtures: LifetimeFixture[] = [];
let root: Promise<string> | undefined;

class LifetimeFixture {
	readonly key = `eval-browser-${crypto.randomUUID()}`;
	readonly names = new Set<string>();
	readonly held = new Set<WorkerTabSession>();
	readonly session: ToolSession;
	readonly prelude: EvalPreludeDefinition;
	definition: EvalPreludeDefinition;

	constructor(readonly root: string) {
		this.session = {
			cwd: root,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getSessionId: () => this.key,
			getEvalPreludes: () => [this.definition],
			settings: Settings.isolated({
				"browser.enabled": true,
				"browser.headless": true,
				"browser.cmux": false,
				"browser.tern": false,
				"browser.relay": false,
				"browser.cdpUrl": "",
				"tools.maxTimeout": 0,
			}),
		};
		this.prelude = createBrowserPrelude(this.session);
		this.definition = this.prelude;
	}

	name(): string {
		const name = `lease-${crypto.randomUUID()}`;
		this.names.add(name);
		return name;
	}

	openCode(name: string, lifetime = "eval"): string {
		return `await browser.open(${JSON.stringify({
			name,
			lifetime,
			url: "data:text/html,<title>owned lifetime fixture</title><button>Local only</button>",
			app: { relay: false, tern: false },
		})})`;
	}

	run(code: string, signal?: AbortSignal, onText?: (text: string) => void, reset = false) {
		return executeInVmContext({
			sessionKey: this.key,
			sessionId: this.key,
			ownerId: this.key,
			cwd: this.root,
			session: this.session,
			filename: "[browser-lifetime].js",
			code,
			reset,
			runState: { signal, onText },
		});
	}

	hold(name: string): WorkerTabSession {
		const tab = getTab(name);
		if (tab?.backend !== "worker") throw new Error("Expected the owned native page");
		if (!this.held.has(tab)) {
			holdBrowser(tab.browser);
			this.held.add(tab);
		}
		return tab;
	}

	async targets(tab: WorkerTabSession): Promise<string[]> {
		const cdp = await tab.browser.browser.target().createCDPSession();
		try {
			const { targetInfos } = await cdp.send("Target.getTargets");
			return targetInfos.map(target => target.targetId);
		} finally {
			await cdp.detach();
		}
	}
}

async function fixture(): Promise<LifetimeFixture> {
	root ??= fs.mkdtemp(path.join(os.tmpdir(), "omp-eval-lifetime-"));
	const result = new LifetimeFixture(await root);
	fixtures.push(result);
	return result;
}

async function observeOpen<T>(opened: Promise<void>, run: Promise<T>): Promise<void> {
	await Promise.race([
		opened,
		run.then(() => { throw new Error("Eval ended before opening its page"); }),
	]);
}

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		await disposeVmContextsByOwner(fixture.key).catch(() => undefined);
		for (const name of fixture.names) {
			const tab = getTab(name);
			if (tab?.ownerSessionId === fixture.key) await releaseTab(name, { expectedTab: tab }).catch(() => undefined);
		}
		for (const tab of fixture.held) await releaseBrowser(tab.browser, { kill: false });
	}
});

afterAll(async () => {
	if (root) await fs.rm(await root, { recursive: true, force: true });
});

describe.skipIf(!CHROMIUM_AVAILABLE)("native browser Eval lifetime", () => {
	for (const ending of ["success", "throw"] as const) {
		it(`closes the concrete target before reporting Eval ${ending}`, async () => {
			const f = await fixture();
			const name = f.name();
			const opened = Promise.withResolvers<void>();
			let stdout = "";
			const run = f.run(
				`${f.openCode(name)}; print("owned-ready"); ${ending === "throw" ? 'throw new Error("cell failure")' : `await browser.tab(${JSON.stringify(name)}).title()`}`,
				undefined,
				text => {
					stdout += text;
					if (text.includes("owned-ready")) { f.hold(name); opened.resolve(); }
				},
			);
			const outcome = run.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as Error }));
			await observeOpen(opened.promise, run);
			const tab = f.hold(name);
			const result = await outcome;
			if (ending === "throw") {
				expect(!result.ok && result.error.message.includes("cell failure")).toBe(true);
			} else {
				expect(result.ok).toBe(true);
				expect(stdout).toContain("owned lifetime fixture");
			}
			expect(getTab(name)).toBeUndefined();
			expect(await f.targets(tab)).not.toContain(tab.targetId);
		}, 45_000);
	}

	for (const ending of ["reset", "cancel", "timeout", "dispose", "worker-death"] as const) {
		it(`awaits target teardown on ${ending}, without touching a sibling Eval`, async () => {
			const f = await fixture();
			const sibling = await fixture();
			const sentinel = sibling.name();
			await sibling.run(`${sibling.openCode(sentinel, "session")}; "sentinel"`);
			const siblingTab = sibling.hold(sentinel);
			const name = f.name();
			const opened = Promise.withResolvers<void>();
			const controller = new AbortController();
			const body = `${f.openCode(name)}; print("owned-ready"); ${ending === "worker-death" ? "await Bun.sleep(100); process.exit(41)" : "await Bun.sleep(60_000)"}`;
			const onText = (text: string): void => {
				if (text.includes("owned-ready")) { f.hold(name); opened.resolve(); }
			};
			// The executor's real timeout includes startup, so warm both the native
			// browser and this retained JS worker before arming it.
			if (ending === "timeout") {
				const warm = f.name();
				await f.run(`${f.openCode(warm, "session")}; "warm"`);
			}
			const run = ending === "timeout"
				? executeJs(body, { sessionId: f.key, kernelOwnerId: f.key, cwd: f.root, session: f.session, timeoutMs: 5_000, onChunk: onText })
				: f.run(body, controller.signal, onText);
			const outcome = run.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as Error }));
			await observeOpen(opened.promise, run);
			const tab = f.hold(name);
			if (ending === "reset") await f.run('"fresh context"', undefined, undefined, true);
			if (ending === "cancel") controller.abort(new Error("caller cancelled"));
			if (ending === "dispose") await disposeVmContextsByOwner(f.key);
			const result = await outcome;
			if (ending === "timeout") {
				expect(result.ok && "cancelled" in result.value && result.value.cancelled).toBe(true);
			} else {
				expect(result.ok).toBe(false);
			}
			expect(getTab(name)).toBeUndefined();
			expect(await f.targets(tab)).not.toContain(tab.targetId);
			expect(await sibling.targets(siblingTab)).toContain(siblingTab.targetId);
			let siblingOutput = "";
			await sibling.run(
				`(await browser.tab(${JSON.stringify(sentinel)}).title()).toUpperCase()`,
				undefined,
				text => { siblingOutput += text; },
			);
			expect(siblingOutput).toContain("OWNED LIFETIME FIXTURE");
		}, 60_000);
	}

	it("preserves ordinary, persistent, borrowed, user and same-name replacement pages", async () => {
		const f = await fixture();
		const ordinary = f.name();
		const persistent = f.name();
		await f.run(`${f.openCode(ordinary, "session")}; await browser.open(${JSON.stringify({ name: persistent, persist: true, app: { relay: false, tern: false } })}); "ready"`);
		const ordinaryTab = f.hold(ordinary);
		const persistentTab = f.hold(persistent);
		const userPage = await ordinaryTab.browser.browser.newPage();
		try {
			await userPage.goto("data:text/html,<title>User sentinel</title>");
			const borrowed = f.name();
			const endpoint = new URL(ordinaryTab.browser.browser.wsEndpoint());
			await f.run(`await browser.open(${JSON.stringify({ name: borrowed, app: { cdp_url: `http://${endpoint.host}`, target: "User sentinel" } })}); "borrowed"`);
			const borrowedTab = f.hold(borrowed);
			await expect(f.run(f.openCode(persistent))).rejects.toThrow("new, uniquely named");
			const name = f.name();
			await f.run(`const leased = ${f.openCode(name)}; await leased.close(); ${f.openCode(name, "session")}; "replaced"`);
			const replacement = f.hold(name);
			expect(await f.targets(replacement)).toContain(replacement.targetId);
			expect(await f.targets(ordinaryTab)).toContain(ordinaryTab.targetId);
			expect(await f.targets(persistentTab)).toContain(persistentTab.targetId);
			expect(await f.targets(borrowedTab)).toContain(borrowedTab.targetId);
			expect(await userPage.title()).toBe("User sentinel");
			expect(getTab(persistent)?.persist).toBe(true);
			await releaseTab(borrowed, { expectedTab: borrowedTab });
			expect(await userPage.title()).toBe("User sentinel");
		} finally {
			await userPage.close();
		}
	}, 60_000);

});

describe("browser lifetime fail-closed boundaries", () => {
	it("rejects an unsupported Eval surface before opening a native page", async () => {
		const f = await fixture();
		const name = f.name();
		await expect(f.prelude.invoke({ action: "open", name, lifetime: "eval" }, {
			session: f.session, toolCallId: "unsupported-surface",
		})).rejects.toThrow("supported JavaScript Eval");
		expect(getTab(name)).toBeUndefined();
	});

	for (const conflict of [{ persist: true }, { app: { target: "User sentinel" } }, { app: { cdp_url: "ws://127.0.0.1:1/unused" } }]) {
		it(`rejects contradictory or borrowed ownership ${JSON.stringify(conflict)} before acquisition`, async () => {
			const f = await fixture();
			const name = f.name();
			await expect(f.prelude.invoke({ action: "open", name, lifetime: "eval", ...conflict }, {
				session: f.session,
				toolCallId: "ownership-conflict",
				registerCleanup: async () => { throw new Error("No resource may be acquired"); },
			})).rejects.toThrow(/persist|adopt|supports only/);
			expect(getTab(name)).toBeUndefined();
		});
	}
});
