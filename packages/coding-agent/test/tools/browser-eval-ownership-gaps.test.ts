import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { BrowserCleanupError, type BrowserCleanupReport } from "@oh-my-pi/pi-coding-agent/tools/browser/lifetime";
import {
	acquireTab,
	getTab,
	releaseTab,
	retryBrowserCleanup,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { hostTurn, OwnedBrowserLifetime, type RunOutcome } from "../helpers/owned-browser-lifetime";

// These exercise real Eval/native cores, acquisition queues and teardown against
// finite owned upstream peers. They do not prove renderer or video correctness.
type Attempt<T> = { ok: true; value: T } | { ok: false; error: Error };
function attempt<T>(operation: Promise<T>): Promise<Attempt<T>> {
	return operation.then<Attempt<T>, Attempt<T>>(
		value => ({ ok: true, value }),
		error => ({ ok: false, error: error instanceof Error ? error : new Error(String(error)) }),
	);
}
function reach<T>(phase: Promise<T>, operation: Promise<{ ok: boolean; error?: unknown }>): Promise<T> {
	return Promise.race([phase, operation.then(result => {
		if (!result.ok) throw result.error;
		throw new Error("Native operation ended before its controlled phase");
	})]);
}

let owned: OwnedBrowserLifetime;
beforeEach(async () => { owned = await OwnedBrowserLifetime.create({ isolatedEval: true }); });
afterEach(async () => { await owned.dispose(); });

describe("late initialization preserves actual page ownership", () => {
	for (const ownership of ["borrowed", "owned"] as const) {
		it(`${ownership} initialization failure ${ownership === "borrowed" ? "preserves the user's page" : "closes only its created page"}`, async () => {
			const user = owned.newTarget();
			const userPeer = owned.pagePeer(user, { failUserAgent: ownership === "borrowed" });
			user.ready.resolve(userPeer.page);
			const unrelated = owned.newTarget();
			const unrelatedPeer = owned.pagePeer(unrelated);
			unrelated.ready.resolve(unrelatedPeer.page);
			const name = `late-init-${crypto.randomUUID()}`;
			const opening = attempt(acquireTab(name, ownership === "borrowed" ? owned.connectedHandle() : owned.handle, {
				timeoutMs: 2_000,
				target: ownership === "borrowed" ? user.id : undefined,
				ownerSessionId: owned.owner,
			}));
			const target = ownership === "borrowed" ? user : await reach(owned.created.promise, opening);
			const peer = ownership === "borrowed" ? userPeer : owned.pagePeer(target, { failUserAgent: true });
			if (ownership === "owned") target.ready.resolve(peer.page);
			// This upstream failure happens after WorkerCore has acquired the page
			// and assigned its target id, not during selection or setup.
			await reach(peer.userAgentRequested.promise, opening);
			const result = await opening;
			expect(result.ok).toBe(false);
			expect(getTab(name)).toBeUndefined();
			if (ownership === "borrowed") {
				expect(target.present).toBe(true);
				expect(target.closeAttempts).toBe(0);
			} else {
				expect(target.present).toBe(false);
				expect(target.closeAttempts).toBeGreaterThan(0);
				expect(user.present).toBe(true);
				expect(user.closeAttempts).toBe(0);
			}
			expect(unrelated.present).toBe(true);
			expect(unrelated.closeAttempts).toBe(0);
		}, 30_000);
	}
});

async function openDownloadTab() {
	const opening = attempt(acquireTab(`download-cleanup-${crypto.randomUUID()}`, owned.handle, {
		timeoutMs: 2_000, ownerSessionId: owned.owner,
		downloadsPath: path.join(owned.root, "downloads"),
	}));
	const target = await reach(owned.created.promise, opening);
	const peer = owned.pagePeer(target);
	target.ready.resolve(peer.page);
	const result = await opening;
	if (!result.ok) throw result.error;
	const tab = result.value.tab;
	if (tab.backend !== "worker") throw new Error("Expected a native worker tab");
	return { target, tab, endpoint: owned.workerFor(tab) };
}

describe("native cleanup retry accounts for earlier passes", () => {
	it("cannot emit a terminal acknowledgement or retire while the first download detach remains held", async () => {
		const detach = owned.holdDownloadDetach();
		const { tab, target, endpoint } = await openDownloadTab();
		const firstReport = endpoint.nextCleanupReport();
		const first = attempt(releaseTab(tab.name, { expectedTab: tab, timeoutMs: 1 }));
		await reach(detach.entered.promise, first);
		const initial = await firstReport;
		const firstResult = await first;
		if (firstResult.ok || !(firstResult.error instanceof BrowserCleanupError)) {
			detach.allow.resolve();
			await detach.finished.promise;
			throw new Error("Held native cleanup did not surface typed uncertainty");
		}
		const workerId = firstResult.error.issues.find(issue => issue.workerId)?.workerId;
		if (!workerId) { detach.allow.resolve(); throw new Error("Missing retained native identity"); }
		const nextReport = endpoint.nextCleanupReport();
		let retryAtSettlement: { ok: boolean; detachActive: boolean } | undefined;
		const retry = attempt(retryBrowserCleanup(workerId)).then(result => {
			retryAtSettlement = { ok: result.ok, detachActive: detach.active };
			return result;
		});
		let report: BrowserCleanupReport | undefined;
		let detachAtReport = false;
		let retryBeforeRelease: { ok: boolean; detachActive: boolean } | undefined;
		try {
			report = await reach(nextReport, retry);
			detachAtReport = detach.active;
			await hostTurn();
			retryBeforeRelease = retryAtSettlement;
		} finally {
			// Failed-before assertions never strand a real native close operation.
			detach.allow.resolve();
		}
		await detach.finished.promise;
		const result = await retry;
		await endpoint.retired.promise;
		if (!report) throw new Error("Retry did not produce a native acknowledgement");
		expect(initial.issues.some(issue => issue.state === "unconfirmed")).toBe(true);
		expect(detachAtReport).toBe(true);
		expect(report.issues.some(issue => issue.state === "unconfirmed")).toBe(true);
		if (retryBeforeRelease?.ok) expect(retryBeforeRelease.detachActive).toBe(false);
		expect(result.ok).toBe(true);
		expect(detach.active).toBe(false);
		expect(target.present).toBe(false);
	}, 30_000);

	it("confirms and retires once download detach actually completes", async () => {
		const detach = owned.holdDownloadDetach();
		detach.allow.resolve();
		const { tab, target, endpoint } = await openDownloadTab();
		const report = endpoint.nextCleanupReport();
		const result = await attempt(releaseTab(tab.name, { expectedTab: tab, timeoutMs: 100 }));
		const closed = await report;
		await detach.finished.promise;
		await endpoint.retired.promise;
		expect(result.ok).toBe(true);
		expect(closed.issues.some(issue => issue.state === "unconfirmed")).toBe(false);
		expect(detach.active).toBe(false);
		expect(target.present).toBe(false);
	}, 30_000);
});

describe("serialized ordinary opens respect Eval ownership", () => {
	for (const lifetime of ["eval", "session"] as const) {
		it(`${lifetime === "eval" ? "rejects a different generation before it can navigate or persist" : "allows ordinary session reuse to navigate and persist"} after dequeue`, async () => {
			const name = `queued-owner-${crypto.randomUUID()}`;
			const ownerReady = Promise.withResolvers<void>();
			const first = owned.start(
				`await browser.open(${JSON.stringify({ name, lifetime, app: { relay: false, tern: false } })}); print("owner-ready"); await Promise.withResolvers().promise`,
				owned.cancelled.signal, owned.owner,
				text => { if (text.includes("owner-ready")) ownerReady.resolve(); },
			);
			const target = await reach(owned.created.promise, first);
			await reach(target.pageRequested.promise, first);
			const peer = owned.pagePeer(target);
			const initialUrl = peer.url();
			const destination = "https://owned-fixture.invalid/queued-destination";
			const queued = owned.nextAcquisition(name);
			const second = owned.start(
				`const tab = await browser.open(${JSON.stringify({ name, url: destination, persist: true, app: { relay: false, tern: false } })}); print(await tab.url())`,
				undefined, `${owned.owner}-other-generation`,
			);
			let secondResult: RunOutcome | undefined;
			let urlAfter = initialUrl;
			let persisted: boolean | undefined;
			let presentBeforeOwnerEnded = false;
			try {
				// Both host preflights see no tab; the second call has reached the
				// real per-name acquisition queue before the first page is published.
				await reach(queued, second);
				target.ready.resolve(peer.page);
				await reach(ownerReady.promise, first);
				secondResult = await second;
				urlAfter = peer.url();
				persisted = getTab(name)?.persist;
				presentBeforeOwnerEnded = target.present;
			} finally {
				target.ready.resolve(peer.page);
				owned.cancelled.abort(new Error("Owned queue fixture released its owner"));
				await first;
				await second;
			}
			if (!secondResult) throw new Error("Queued open did not settle");
			expect(presentBeforeOwnerEnded).toBe(true);
			if (lifetime === "eval") {
				expect(secondResult.ok).toBe(false);
				expect(urlAfter).toBe(initialUrl);
				expect(persisted).toBe(false);
				expect(target.present).toBe(false);
			} else {
				expect(secondResult.ok, secondResult.ok ? undefined : secondResult.error.stack ?? secondResult.error.message).toBe(true);
				expect(urlAfter).toBe(destination);
				expect(persisted).toBe(true);
				expect(target.present).toBe(true);
			}
		}, 30_000);
	}
});
