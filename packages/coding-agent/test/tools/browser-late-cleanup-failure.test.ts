import { afterEach, expect, it } from "bun:test";
import { BrowserCleanupError, type BrowserCleanupReport } from "@oh-my-pi/pi-coding-agent/tools/browser/lifetime";
import { RecordingController } from "@oh-my-pi/pi-coding-agent/tools/browser/recording";
import { releaseTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { OwnedBrowserLifetime, OwnedFrameSource } from "../helpers/owned-browser-lifetime";

let owned: OwnedBrowserLifetime | undefined;
afterEach(async () => { await owned?.dispose(); owned = undefined; });

it("does not replace a late encoder failure with a successful native cleanup acknowledgement", async () => {
	const fixture = await OwnedBrowserLifetime.create();
	owned = fixture;
	const controller = new RecordingController();
	const source = new OwnedFrameSource();
	fixture.observeRecording(controller);
	fixture.frameSources.add(source);
	await controller.start(source, "late-failure.mp4", fixture.root, { cursor: false });
	const tab = await fixture.tab({ controller });
	// Enter the real controller's finalization before requesting native close;
	// the owned encoder stays held until the independent close signal aborts it.
	const stopping = controller.stop().then(() => ({ failed: false }), () => ({ failed: true }));
	await fixture.encoder.entered.promise;
	const terminal = Promise.withResolvers<BrowserCleanupReport>();
	const unsubscribe = tab.worker.onMessage(message => {
		if (message.type === "closed" && message.cleanup &&
			!message.cleanup.issues.some(issue => issue.state === "unconfirmed")) terminal.resolve(message.cleanup);
	});
	try {
		const release = releaseTab(tab.name, { expectedTab: tab, timeoutMs: 1 }).then(
			() => ({ ok: true as const }),
			error => ({ ok: false as const, error }),
		);
		const report = await terminal.promise;
		const result = await release;
		expect((await stopping).failed).toBe(true);
		expect(report.issues).toContainEqual(expect.objectContaining({ resource: "recording", state: "failed" }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBeInstanceOf(BrowserCleanupError);
		expect(source.active).toBe(false);
		expect(fixture.encoder.active).toBe(false);
		expect(controller.status().active).toBe(false);
	} finally {
		unsubscribe();
	}
}, 30_000);
