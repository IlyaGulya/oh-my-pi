import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resetVmContext } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { RecordingController } from "@oh-my-pi/pi-coding-agent/tools/browser/recording";
import {
	dropHeadlessTabs,
	getTab,
	releaseAllTabs,
	releaseTab,
	releaseTabsForOwner,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { hostTurn, OwnedBrowserLifetime, OwnedFrameSource, type RunOutcome } from "../helpers/owned-browser-lifetime";

type BoundaryOutcome = { ok: true } | { ok: false; error: Error };

function boundary(promise: Promise<unknown>): Promise<BoundaryOutcome> {
	return promise.then<BoundaryOutcome, BoundaryOutcome>(
		() => ({ ok: true }),
		error => ({ ok: false, error: error instanceof Error ? error : new Error(String(error)) }),
	);
}

function cancelledRun(run: Promise<RunOutcome>): Promise<BoundaryOutcome> {
	return run.then(outcome => outcome.ok ? { ok: true } : { ok: false, error: outcome.error });
}

function reach<T>(phase: Promise<T>, run: Promise<RunOutcome>): Promise<T> {
	return Promise.race([
		phase,
		run.then(result => {
			if (!result.ok) throw result.error;
			throw new Error("Eval completed before reaching its owned native fixture phase");
		}),
	]);
}

async function absent(directory: string): Promise<boolean> {
	try { await fs.stat(directory); return false; }
	catch (error) { if (isEnoent(error)) return true; throw error; }
}

let owned: OwnedBrowserLifetime;
beforeEach(async () => { owned = await OwnedBrowserLifetime.create(); });
afterEach(async () => {
	vi.useRealTimers();
	await owned.dispose();
});

describe("Eval-owned acquisition drains", () => {
	for (const ending of ["reset", "cancel"] as const) {
		for (const close of ["confirmed", "unconfirmed"] as const) {
			it(`${ending} waits for an in-flight page and reports its ${close} late close`, async () => {
				const ordinary = await owned.tab();
				const persistent = await owned.tab({ persist: true });
				const borrowed = await owned.tab({ borrowed: true });
				const user = owned.newTarget();
				const sibling = `${owned.owner}-sibling`;
				const first = await owned.start("globalThis.siblingState = 7; siblingState * 6", undefined, sibling);
				expect(first.ok && first.stdout.includes("42")).toBe(true);

				const name = `acquiring-${crypto.randomUUID()}`;
				const run = owned.start(`await browser.open(${JSON.stringify({
					name, lifetime: "eval", app: { relay: false, tern: false },
				})}); print("escaped-owned-handle")`, owned.cancelled.signal);
				const target = await reach(owned.created.promise, run);
				await target.pageRequested.promise;
				target.unconfirmed = close === "unconfirmed";
				let boundaryResult: BoundaryOutcome | undefined;
				const stopping = (ending === "reset"
					? boundary(resetVmContext(owned.owner))
					: cancelledRun(run)
				).then(outcome => { boundaryResult = outcome; return outcome; });
				if (ending === "cancel") owned.cancelled.abort(new Error("Owned caller cancelled"));
				await hostTurn();
				const endedBeforeInitialization = boundaryResult !== undefined;

				// The native worker has already announced page-created. Its page()
				// handshake fails only now, after the whole-Eval boundary started.
				target.ready.reject(new Error("Owned page initialization failed after creation"));
				await target.closeRequested.promise;
				await hostTurn();
				const endedBeforeCloseConfirmation = boundaryResult !== undefined;
				target.allowClose.resolve();
				await target.closeFinished.promise;
				const [execution, stopped] = await Promise.all([run, stopping]);
				const retained = await owned.recordedTargets();

				// Assert only after releasing all gates: a failing-before assertion
				// must not strand an acquisition or hide the late native close result.
				expect(endedBeforeInitialization).toBe(false);
				expect(endedBeforeCloseConfirmation).toBe(false);
				expect(execution.ok).toBe(false);
				expect(execution.stdout).not.toContain("escaped-owned-handle");
				if (close === "unconfirmed") {
					expect(stopped.ok).toBe(false);
					if (!stopped.ok) expect(stopped.error.message).toMatch(/cleanup|close|stop|confirm/i);
					expect(retained).toContain(target.id);
					expect(target.present).toBe(true);
				} else {
					if (ending === "reset") expect(stopped.ok).toBe(true);
					expect(retained).not.toContain(target.id);
					expect(target.present).toBe(false);
				}
				for (const control of [ordinary, persistent, borrowed]) {
					expect(getTab(control.name)).toBe(control);
					expect(owned.targets.get(control.targetId)?.present).toBe(true);
				}
				expect(user.present).toBe(true);
				const after = await owned.start("siblingState * 9", undefined, sibling);
				expect(after.ok && after.stdout.includes("63")).toBe(true);
			}, 30_000);
		}
	}

	for (const close of ["confirmed", "unconfirmed"] as const) {
		it(`failed initialization ${close === "confirmed" ? "closes its abandoned target" : "retains an abandoned target whose close fails"}`, async () => {
			const run = owned.start(`await browser.open(${JSON.stringify({
				name: `failed-init-${crypto.randomUUID()}`, lifetime: "eval", app: { relay: false, tern: false },
			})})`, owned.cancelled.signal);
			const target = await reach(owned.created.promise, run);
			await target.pageRequested.promise;
			target.unconfirmed = close === "unconfirmed";
			let resultBeforeClose: RunOutcome | undefined;
			const observed = run.then(result => { resultBeforeClose = result; return result; });
			target.ready.reject(new Error("Owned initialization rejected after page-created"));
			await target.closeRequested.promise;
			await hostTurn();
			const escapedBeforeCleanup = resultBeforeClose !== undefined;
			target.allowClose.resolve();
			await target.closeFinished.promise;
			const result = await observed;
			const retained = await owned.recordedTargets();
			expect(result.ok).toBe(false);
			if (close === "unconfirmed") {
				expect(escapedBeforeCleanup).toBe(false);
				if (!result.ok) expect(result.error.message).toMatch(/cleanup|close|stop|confirm/i);
				expect(target.present).toBe(true);
				expect(retained).toContain(target.id);
			} else {
				// Positive control: this is a native initialization error, not a
				// fabricated lease result; a confirmed abandoned close loses no target.
				expect(target.present).toBe(false);
				expect(retained).not.toContain(target.id);
			}
		}, 30_000);
	}
});

interface RecordingSnapshot {
	outcome: BoundaryOutcome;
	collectorActive: boolean;
	encoderActive: boolean;
	recordingActive: boolean;
}

function expectNoFalseConfirmation(snapshot: RecordingSnapshot | undefined): void {
	if (!snapshot) return; // Still pending while its native resource is held.
	const active = snapshot.collectorActive || snapshot.encoderActive || snapshot.recordingActive;
	if (snapshot.outcome.ok) expect(active).toBe(false);
	else if (active) expect(snapshot.outcome.error.message).toMatch(/cleanup|record|encoder|stop|confirm/i);
}

describe("Eval-owned recorder teardown", () => {
	it("confirms an already-finishing real RecordingController without leaving its spool or encoder live", async () => {
		const controller = new RecordingController();
		const source = new OwnedFrameSource();
		owned.observeRecording(controller);
		owned.frameSources.add(source);
		await controller.start(source, "positive.mp4", owned.root, { cursor: false });
		const tab = await owned.tab({ controller });
		owned.encoder.finish.resolve();
		const result = await owned.start(`${owned.claimCode(tab)}; 6 * 7`, owned.cancelled.signal);
		expect(result.ok).toBe(true);
		expect(source.active).toBe(false);
		expect(owned.encoder.active).toBe(false);
		expect(controller.status().active).toBe(false);
		expect(owned.targets.get(tab.targetId)?.present).toBe(false);
		if (!owned.encoder.spool) throw new Error("The real controller never reached encoding");
		expect(await absent(owned.encoder.spool)).toBe(true);
	}, 30_000);

	const cases = [
		{ name: "slow encoder", ending: "complete", blockCollector: false, failEncoder: false },
		{ name: "failed encoder", ending: "complete", blockCollector: false, failEncoder: true },
		{ name: "collector still stopping", ending: "cancel", blockCollector: true, failEncoder: false },
		{ name: "failed encoder", ending: "reset", blockCollector: false, failEncoder: true },
	] as const;
	for (const scenario of cases) {
		it(`${scenario.ending} cannot falsely confirm ${scenario.name} after the 750ms worker grace`, async () => {
			const controller = new RecordingController();
			const source = new OwnedFrameSource(scenario.blockCollector);
			owned.observeRecording(controller);
			owned.frameSources.add(source);
			await controller.start(source, "held.mp4", owned.root, { cursor: false });
			const tab = await owned.tab({ controller });
			const worker = owned.workerFor(tab);
			const snapshot = (outcome: BoundaryOutcome): RecordingSnapshot => ({
				outcome, collectorActive: source.active,
				encoderActive: owned.encoder.active, recordingActive: controller.status().active,
			});
			let executionAtSettlement: RecordingSnapshot | undefined;
			let boundaryAtSettlement: RecordingSnapshot | undefined;
			vi.useFakeTimers();
			const run = owned.start(
				`${owned.claimCode(tab)}; ${scenario.ending === "complete" ? "6 * 7" : "await Promise.withResolvers().promise"}`,
				owned.cancelled.signal,
			).then(result => {
				executionAtSettlement = snapshot(result.ok ? { ok: true } : { ok: false, error: result.error });
				return result;
			});
			await reach(owned.claimed.promise, run);
			const stop = (scenario.ending === "reset"
				? boundary(resetVmContext(owned.owner))
				: cancelledRun(run)
			).then(result => { boundaryAtSettlement = snapshot(result); return result; });
			if (scenario.ending === "cancel") owned.cancelled.abort(new Error("Owned caller cancelled"));
			await worker.closeRequested.promise;
			if (scenario.blockCollector) await source.stopRequested.promise;
			else await owned.encoder.entered.promise;
			vi.advanceTimersByTime(751);
			await hostTurn();
			const executionAtGrace = executionAtSettlement;
			const boundaryAtGrace = boundaryAtSettlement;

			// Only this fixture can release these resources. Retirement of a native
			// JS endpoint is deliberately not treated as stopping an external encoder.
			source.allowStop.resolve();
			if (scenario.failEncoder) owned.encoder.finish.reject(new Error("Owned encoder finalization failed"));
			else owned.encoder.finish.resolve();
			const [execution, stopped] = await Promise.all([run, stop]);
			await owned.recordingFinished(controller);

			expectNoFalseConfirmation(executionAtGrace);
			expectNoFalseConfirmation(boundaryAtGrace);
			expectNoFalseConfirmation(executionAtSettlement);
			expectNoFalseConfirmation(boundaryAtSettlement);
			if (scenario.failEncoder) {
				expect(execution.ok).toBe(false);
				if (scenario.ending === "reset") expect(stopped.ok).toBe(false);
			}
			expect(source.active).toBe(false);
			expect(owned.encoder.active).toBe(false);
			expect(controller.status().active).toBe(false);
			expect(owned.targets.get(tab.targetId)?.present).toBe(false);
			if (!owned.encoder.spool) throw new Error("The real controller never reached encoding");
			expect(await absent(owned.encoder.spool)).toBe(true);
			if (scenario.failEncoder) expect(await Bun.file(path.join(owned.root, "held.mp4")).exists()).toBe(false);
		}, 30_000);
	}
});

describe("ordinary tab bulk-close failure isolation", () => {
	for (const sweep of ["owner", "all", "headless"] as const) {
		for (const close of ["confirmed", "unconfirmed"] as const) {
			it(`${sweep} continues to later ordinary tabs after an earlier ${close} close`, async () => {
				const first = await owned.tab();
				const later = await owned.tab();
				const persistent = await owned.tab({ persist: true });
				const otherOwner = await owned.tab({ owner: `${owned.owner}-other` });
				const borrowed = await owned.tab({ borrowed: true });
				const user = owned.newTarget();
				const firstTarget = owned.targets.get(first.targetId);
				if (!firstTarget) throw new Error("Missing owned first target");
				firstTarget.unconfirmed = close === "unconfirmed";
				owned.assertOnlyOwnedManagedTabs();
				const result = await boundary(sweep === "owner"
					? releaseTabsForOwner(owned.owner, { timeoutMs: 100 })
					: sweep === "all" ? releaseAllTabs({ timeoutMs: 100 }) : dropHeadlessTabs());
				expect(getTab(later.name)).toBeUndefined();
				expect(owned.targets.get(later.targetId)?.present).toBe(false);
				// persist opts out of settle/idle reaping, not an explicit owner/all close.
				expect(getTab(persistent.name)).toBeUndefined();
				expect(owned.targets.get(persistent.targetId)?.present).toBe(false);
				expect(owned.targets.get(borrowed.targetId)?.present).toBe(true);
				expect(user.present).toBe(true);
				if (sweep === "owner") {
					expect(getTab(otherOwner.name)).toBe(otherOwner);
					expect(owned.targets.get(otherOwner.targetId)?.present).toBe(true);
				} else expect(owned.targets.get(otherOwner.targetId)?.present).toBe(false);
				if (close === "unconfirmed") {
					expect(result.ok).toBe(false);
					expect(await owned.recordedTargets()).toContain(first.targetId);
				} else {
					expect(result.ok).toBe(true);
					expect(await owned.recordedTargets()).not.toContain(first.targetId);
				}
			}, 30_000);
		}
	}

	it("an exact old lease cannot release a same-name replacement or borrowed/persistent controls", async () => {
		const original = await owned.tab();
		const run = owned.start(
			`${owned.claimCode(original)}; await Promise.withResolvers().promise`, owned.cancelled.signal,
		);
		await reach(owned.claimed.promise, run);
		await releaseTab(original.name, { expectedTab: original });
		const replacement = await owned.tab({ name: original.name });
		const persistent = await owned.tab({ persist: true });
		const borrowed = await owned.tab({ borrowed: true });
		owned.cancelled.abort(new Error("Owned caller cancelled after explicit close and replacement"));
		const result = await run;
		expect(result.ok).toBe(false);
		await releaseTab(original.name, { expectedTab: original });
		for (const survivor of [replacement, persistent, borrowed]) {
			expect(getTab(survivor.name)).toBe(survivor);
			expect(owned.targets.get(survivor.targetId)?.present).toBe(true);
		}
	}, 30_000);
});
