import { spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	disposeVmContextsByOwner,
	executeInVmContext,
	type JsEvalWorkerHandle,
	setJsEvalWorkerFactoriesForTests,
} from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { WorkerCore as EvalWorkerCore } from "@oh-my-pi/pi-coding-agent/eval/js/worker-core";
import type {
	WorkerInbound as EvalInbound,
	WorkerOutbound as EvalOutbound,
} from "@oh-my-pi/pi-coding-agent/eval/js/worker-protocol";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import { daemonRuntimeDir } from "@oh-my-pi/pi-coding-agent/launch/paths";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import * as launch from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { forgetSharedTarget, recordSharedTarget, type SharedTargetScope } from "@oh-my-pi/pi-coding-agent/tools/browser/orphan-registry";
import * as recording from "@oh-my-pi/pi-coding-agent/tools/browser/recording";
import type {
	RecordingFrameSource,
	RecordingFrameSourceStartParams,
} from "@oh-my-pi/pi-coding-agent/tools/browser/recording";
import * as registry from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import * as sharedDaemon from "@oh-my-pi/pi-coding-agent/tools/browser/shared-daemon";
import type { BrowserCleanupReport } from "@oh-my-pi/pi-coding-agent/tools/browser/lifetime";
import type { WorkerInbound, WorkerOutbound } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import * as supervisor from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { WorkerTabSession } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { WorkerCore as BrowserWorkerCore } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import * as uploads from "@oh-my-pi/pi-coding-agent/tools/browser/upload-files";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import * as video from "@oh-my-pi/pi-coding-agent/utils/video";
import { isEnoent, postmortem } from "@oh-my-pi/pi-utils";
import * as puppeteer from "puppeteer-core";
import type { Browser, CDPSession, Frame, Page, Target } from "puppeteer-core";

// Capture host scheduling before an Eval realm can replace timer globals.
const hostImmediate = setImmediate;
const hostTimeout = setTimeout;
export async function hostTurn(): Promise<void> {
	const turn = Promise.withResolvers<void>();
	hostImmediate(() => turn.resolve());
	await turn.promise;
}

/** Keep native resource gates held beyond the supervisor's 750ms close grace. */
export async function waitPastNativeCloseGrace(): Promise<void> {
	const elapsed = Promise.withResolvers<void>();
	hostTimeout(() => elapsed.resolve(), 1_000);
	await elapsed.promise;
	await hostTurn();
}

export type RunOutcome = { ok: true; stdout: string } | { ok: false; error: Error; stdout: string };

/** Real Eval worker core, but no subprocess, thread, process.exit, or PID callback. */
function evalWorker(): JsEvalWorkerHandle {
	const listeners = new Set<(message: EvalOutbound) => void>();
	let receive: ((message: EvalInbound) => void) | undefined;
	const closed = Promise.withResolvers<void>();
	const core = new EvalWorkerCore({
		send(message) {
			queueMicrotask(() => {
				if (message.type === "closed") closed.resolve();
				for (const listener of listeners) listener(message);
			});
		},
		onMessage(handler) { receive = handler; return () => { receive = undefined; }; },
		close() {},
	}, { mode: "inline", interceptUnhandledRejections: postmortem.interceptUnhandledRejections });
	return {
		mode: "worker",
		send(message) { queueMicrotask(() => receive?.(message)); },
		onMessage(handler) { listeners.add(handler); return () => listeners.delete(handler); },
		onError() { return () => {}; },
		async close() { receive?.({ type: "close" }); await closed.promise; return true; },
		async terminate() { core.dispose(); listeners.clear(); },
	};
}

/** Native WorkerCore transport whose retirement only detaches this owned endpoint. */
export class OwnedTabWorker extends EventTarget {
	readonly closeRequested = Promise.withResolvers<void>();
	readonly retired = Promise.withResolvers<void>();
	targetId?: string;
	#receive: ((message: WorkerInbound | WorkerOutbound) => void) | undefined;
	#closing = false;
	#retired = false;

	constructor(controller?: recording.RecordingController) {
		super();
		const constructor = controller
			? spyOn(recording, "RecordingController").mockImplementation(function ownedController() {
				return controller;
			} as never)
			: undefined;
		try {
			new BrowserWorkerCore({
				send: message => {
					if (message.type === "page-created") this.targetId = message.targetId;
					if (message.type === "ready") this.targetId = message.info.targetId;
					queueMicrotask(() => {
						if (!this.#retired) this.dispatchEvent(new MessageEvent("message", { data: message }));
					});
				},
				onMessage: handler => { this.#receive = handler; return () => { this.#receive = undefined; }; },
				close() {},
			}, false);
		} finally {
			constructor?.mockRestore();
		}
	}

	postMessage(message: WorkerInbound): void {
		if (message.type === "close") {
			this.#closing = true;
			this.closeRequested.resolve();
		}
		queueMicrotask(() => this.#receive?.(message));
	}

	terminate(): void {
		// No OS process exists here. In particular, do not resolve an encoder or
		// stop a frame source just because the JS worker transport was retired.
		if (!this.#closing) this.postMessage({ type: "close" });
		this.#retired = true;
		this.retired.resolve();
	}

	handle(): WorkerTabSession["worker"] {
		return {
			mode: "worker",
			send: message => this.postMessage(message),
			onMessage: handler => {
				const listener = (event: Event): void => handler((event as MessageEvent<WorkerOutbound>).data);
				this.addEventListener("message", listener);
				return () => this.removeEventListener("message", listener);
			},
			onError: () => () => {},
			onExit: () => () => {},
			terminate: async () => this.terminate(),
		};
	}

	nextCleanupReport(): Promise<BrowserCleanupReport> {
		const report = Promise.withResolvers<BrowserCleanupReport>();
		const unsubscribe = this.handle().onMessage(message => {
			if (message.type !== "closed" || !message.cleanup) return;
			unsubscribe();
			report.resolve(message.cleanup);
		});
		return report.promise;
	}
}

export interface OwnedTarget {
	id: string;
	ready: PromiseWithResolvers<Page>;
	pageRequested: PromiseWithResolvers<void>;
	closeRequested: PromiseWithResolvers<void>;
	closeFinished: PromiseWithResolvers<void>;
	allowClose: PromiseWithResolvers<void>;
	unconfirmed: boolean;
	present: boolean;
	closeAttempts: number;
}

export interface OwnedPagePeer {
	page: Page;
	userAgentRequested: PromiseWithResolvers<void>;
	url(): string;
}

export interface OwnedDetachGate {
	entered: PromiseWithResolvers<void>;
	allow: PromiseWithResolvers<void>;
	finished: PromiseWithResolvers<void>;
	active: boolean;
}

/** A finite frame source; gates model a collector that has not yet stopped. */
export class OwnedFrameSource implements RecordingFrameSource {
	active = false;
	readonly stopRequested = Promise.withResolvers<void>();
	readonly allowStop = Promise.withResolvers<void>();
	readonly bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
	#blocked: boolean;

	constructor(blockStop = false) { this.#blocked = blockStop; }
	async viewport() { return { width: 2, height: 2 }; }
	async start(params: RecordingFrameSourceStartParams): Promise<void> {
		this.active = true;
		await params.onFrame({ data: this.bytes, timestampMs: 0 });
	}
	async stop(): Promise<void> {
		this.stopRequested.resolve();
		if (this.#blocked) await this.allowStop.promise;
		this.active = false;
	}
	async captureFrame(): Promise<Uint8Array> { return this.bytes; }
	async installCursor(): Promise<void> {}
	async removeCursor(): Promise<void> {}
}

/** Owns the encoder seam only: never launches or kills ffmpeg or any PID. */
export class OwnedEncoder {
	active = false;
	readonly entered = Promise.withResolvers<void>();
	readonly finish = Promise.withResolvers<void>();
	spool: string | undefined;

	constructor(readonly root: string) {
		// A deliberately injected failure remains awaited by encodeRecording.
		void this.finish.promise.catch(() => undefined);
	}

	async run(args: string[], signal?: AbortSignal): Promise<void> {
		const destination = args.at(-1);
		const concat = args[args.indexOf("-i") + 1];
		if (!destination || path.dirname(destination) !== this.root || !concat) {
			throw new Error("Encoder fixture refused a non-owned output");
		}
		this.spool = path.dirname(concat);
		this.active = true;
		this.entered.resolve();
		const abort = (): void => this.finish.reject(new Error("Owned encoder was cancelled"));
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		try {
			await this.finish.promise;
			// Not a real MP4: these tests assert native resource lifetime, not
			// encoding validity. Parent recorder proof must use actual ffmpeg.
			await Bun.write(destination, "owned-encoder-completed");
		} finally {
			signal?.removeEventListener("abort", abort);
			this.active = false;
		}
	}
}

/** Isolated target/ownership storage plus real Eval, supervisor, and native cores. */
export class OwnedBrowserLifetime {
	readonly owner = `owned-lifetime-${crypto.randomUUID()}`;
	readonly targets = new Map<string, OwnedTarget>();
	readonly workers: OwnedTabWorker[] = [];
	readonly tabs = new Set<WorkerTabSession>();
	readonly created = Promise.withResolvers<OwnedTarget>();
	readonly claimed = Promise.withResolvers<void>();
	readonly cancelled = new AbortController();
	readonly encoder: OwnedEncoder;
	readonly controllers = new Set<recording.RecordingController>();
	readonly frameSources = new Set<OwnedFrameSource>();
	readonly handle: registry.PuppeteerBrowserHandle;
	readonly session: ToolSession;
	readonly scope: SharedTargetScope;
	#restores: Array<() => void> = [];
	#runs: Promise<RunOutcome>[] = [];
	#acquisitions = new Set<Promise<unknown>>();
	#owners = new Set<string>();
	#sessions = new Set<EventEmitter>();
	#preludes: EvalPreludeDefinition[] = [];
	#workersByTab = new Map<WorkerTabSession, OwnedTabWorker>();
	#recordingClosures = new Set<Promise<void>>();
	#recordingFinished = new Map<recording.RecordingController, PromiseWithResolvers<void>>();
	#additionalHandles = new Set<registry.PuppeteerBrowserHandle>();
	#pagePeers = new Map<string, OwnedPagePeer>();
	#acquisitionObservers = new Map<string, () => void>();
	#downloadDetach?: OwnedDetachGate;

	static async create(): Promise<OwnedBrowserLifetime> {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-owned-lifetime-fixture-"));
		const fixture = new OwnedBrowserLifetime(root);
		try {
			fixture.install();
			return fixture;
		} catch (error) {
			await fixture.dispose();
			throw error;
		}
	}

	constructor(readonly root: string) {
		this.scope = { projectDir: root, daemonName: `owned-browser-${this.owner}` };
		this.encoder = new OwnedEncoder(root);
		this.handle = {
			key: this.owner,
			kind: { kind: "headless", headless: true },
			browser: this.browser(),
			refCount: 1, // The fixture's own hold, not a tab or acquisition hold.
			stealth: { browserSession: null, override: null },
			sharedDaemon: { name: this.scope.daemonName, projectDir: root },
		};
		this.session = {
			cwd: root,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getSessionId: () => this.owner,
			getEvalPreludes: () => this.#preludes,
			settings: Settings.isolated({
				"browser.enabled": true, "browser.headless": true,
				"browser.cmux": false, "browser.tern": false,
				"browser.relay": false, "browser.cdpUrl": "", "browser.idleCloseSec": 0,
			}),
		};
		this.#preludes.push(createBrowserPrelude(this.session), {
			name: "ownedNativeFixture", documentation: "Owned native resource fault fixture",
			javascript: "", python: "", exports: [],
			invoke: async (parameters, context) => {
				const name = typeof parameters === "object" && parameters !== null && "name" in parameters
					? parameters.name : undefined;
				const tab = typeof name === "string" ? supervisor.getTab(name) : undefined;
				if (!tab || !this.tabs.has(tab as WorkerTabSession) || !context.registerCleanup) {
					throw new Error("Fixture refused an unowned resource or unsupported Eval");
				}
				await context.registerCleanup(async () => { await supervisor.releaseTab(tab.name, { expectedTab: tab }); });
				this.claimed.resolve();
				return { content: [] };
			},
		});
	}

	install(): void {
		this.#restores.push(setJsEvalWorkerFactoriesForTests({ spawnProcess: evalWorker, spawnWorker: evalWorker }));
		const spawn = spyOn(Bun, "spawn").mockImplementation((() => {
			throw new Error("Owned native fixture refuses OS process creation");
		}) as typeof Bun.spawn);
		this.#restores.push(() => spawn.mockRestore());
		const spawnSync = spyOn(Bun, "spawnSync").mockImplementation((() => {
			throw new Error("Owned native fixture refuses synchronous OS process creation");
		}) as typeof Bun.spawnSync);
		this.#restores.push(() => spawnSync.mockRestore());
		const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => {
			throw new Error("Owned native fixture refuses network requests");
		});
		this.#restores.push(() => fetch.mockRestore());
		const acquireBrowser = spyOn(registry, "acquireBrowser").mockImplementation(async (kind, options) => {
			if (kind.kind !== "headless" || options.cwd !== this.root) throw new Error("Non-owned browser acquisition refused");
			return this.handle;
		});
		this.#restores.push(() => acquireBrowser.mockRestore());
		const chromium = spyOn(launch, "ensureChromiumExecutable").mockResolvedValue("/not-executed/owned-chromium");
		this.#restores.push(() => chromium.mockRestore());
		const load = spyOn(launch, "loadPuppeteerInWorker").mockResolvedValue(puppeteer);
		this.#restores.push(() => load.mockRestore());
		const devices = spyOn(launch, "loadedKnownDevices").mockReturnValue(puppeteer.KnownDevices);
		this.#restores.push(() => devices.mockRestore());
		const networks = spyOn(launch, "loadedNetworkConditions").mockReturnValue(puppeteer.PredefinedNetworkConditions);
		this.#restores.push(() => networks.mockRestore());
		const connect = spyOn(launch, "connectPuppeteer").mockImplementation(async (_puppeteer, options) => {
			if (options.browserWSEndpoint !== `owned-fixture:${this.owner}`) throw new Error("Non-owned CDP connection refused");
			return this.browser();
		});
		this.#restores.push(() => connect.mockRestore());
		const realStealth = launch.applyStealthPatches;
		const stealth = spyOn(launch, "applyStealthPatches").mockImplementation(async (browser, page, state) => {
			if ([...this.#pagePeers.values()].some(peer => peer.page === page)) return;
			await realStealth(browser, page, state);
		});
		this.#restores.push(() => stealth.mockRestore());
		const fixture = this;
		const worker = spyOn(globalThis, "Worker").mockImplementation(function ownedWorker(entry: string, options?: { argv?: string[] }) {
			if (!String(entry).endsWith("/tab-worker-entry.ts") && !options?.argv?.includes("__omp_worker_tab")) {
				throw new Error("Non-owned Worker construction refused");
			}
			const endpoint = new OwnedTabWorker();
			fixture.workers.push(endpoint);
			return endpoint;
		} as never);
		this.#restores.push(() => worker.mockRestore());
		const realAcquire = supervisor.acquireTab;
		const acquire = spyOn(supervisor, "acquireTab").mockImplementation((name, browser, options) => {
			if (browser !== this.handle && !this.#additionalHandles.has(browser as registry.PuppeteerBrowserHandle)) throw new Error("Non-owned tab acquisition refused");
			this.#acquisitionObservers.get(name)?.();
			this.#acquisitionObservers.delete(name);
			const operation = realAcquire(name, browser, options);
			this.#acquisitions.add(operation);
			void operation.then(result => {
				if (result.tab.backend !== "worker") return;
				this.tabs.add(result.tab);
				const endpoint = this.workers.find(worker => worker.targetId === result.tab.targetId);
				if (endpoint) this.#workersByTab.set(result.tab, endpoint);
			}, () => undefined);
			void operation.finally(() => this.#acquisitions.delete(operation)).catch(() => undefined);
			return operation;
		});
		this.#restores.push(() => acquire.mockRestore());
		const cleanup = spyOn(uploads, "removeUploadStaging").mockImplementation(async directory => {
			// No fixture uploads are made. Never remove a caller-supplied directory.
			if (directory && !path.basename(directory).startsWith("omp-uploads-") && !directory.startsWith(this.root + path.sep)) {
				throw new Error("Non-owned upload cleanup refused");
			}
		});
		this.#restores.push(() => cleanup.mockRestore());
		const health = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockImplementation(async scope => {
			if (scope.projectDir !== this.root) throw new Error("Non-owned browser health operation refused");
			return false;
		});
		this.#restores.push(() => health.mockRestore());
		const binary = spyOn(video, "requireMediaBinary").mockReturnValue("/not-executed/owned-ffmpeg");
		this.#restores.push(() => binary.mockRestore());
		const encode = spyOn(video, "runFfmpeg").mockImplementation((args, signal) => this.encoder.run(args, signal));
		this.#restores.push(() => encode.mockRestore());
	}

	newTarget(): OwnedTarget {
		const target: OwnedTarget = {
			id: `target-${crypto.randomUUID()}`,
			ready: Promise.withResolvers<Page>(), pageRequested: Promise.withResolvers<void>(),
			closeRequested: Promise.withResolvers<void>(), closeFinished: Promise.withResolvers<void>(),
			allowClose: Promise.withResolvers<void>(), unconfirmed: false, present: true,
			closeAttempts: 0,
		};
		void target.ready.promise.catch(() => undefined);
		this.targets.set(target.id, target);
		return target;
	}

	/** Observe the next real serialized-acquisition admission; never fabricate its result. */
	nextAcquisition(name: string): Promise<void> {
		if (this.#acquisitionObservers.has(name)) throw new Error("Acquisition observer already registered");
		const entered = Promise.withResolvers<void>();
		this.#acquisitionObservers.set(name, () => entered.resolve());
		return entered.promise;
	}

	connectedHandle(): registry.PuppeteerBrowserHandle {
		const handle: registry.PuppeteerBrowserHandle = {
			...this.handle, key: `${this.owner}-connected-${crypto.randomUUID()}`,
			kind: { kind: "connected", cdpUrl: "http://owned-fixture.invalid" },
			browser: this.browser(), sharedDaemon: undefined, refCount: 1,
		};
		this.#additionalHandles.add(handle);
		return handle;
	}

	holdDownloadDetach(): OwnedDetachGate {
		if (this.#downloadDetach) throw new Error("Download detach gate already configured");
		return this.#downloadDetach = {
			entered: Promise.withResolvers<void>(), allow: Promise.withResolvers<void>(),
			finished: Promise.withResolvers<void>(), active: false,
		};
	}

	/** Finite upstream page peer, not a renderer: native initialization/runs/cleanup remain real. */
	pagePeer(target: OwnedTarget, options: { failUserAgent?: boolean } = {}): OwnedPagePeer {
		if (this.targets.get(target.id) !== target || this.#pagePeers.has(target.id)) throw new Error("Non-owned or duplicate page peer");
		const userAgentRequested = Promise.withResolvers<void>();
		let url = `https://owned-fixture.invalid/${target.id}`;
		let script = 0;
		let viewport = { width: 2, height: 2, deviceScaleFactor: 1 };
		const realm = { evaluate: async () => undefined };
		const frame = {
			_id: target.id, detached: false, client: this.cdp(),
			_lifecycleEvents: new Set(["load", "DOMContentLoaded"]),
			mainRealm: () => realm, childFrames: () => [],
		} as unknown as Frame;
		const page = Object.assign(new EventEmitter(), {
			url: () => url,
			title: async () => new URL(url).pathname,
			isClosed: () => !target.present,
			browser: () => this.handle.browser,
			browserContext: () => ({}),
			mainFrame: () => frame, frames: () => [frame],
			target: () => ({ _targetId: target.id, createCDPSession: async () => this.cdp() }),
			createCDPSession: async () => this.cdp(),
			evaluateOnNewDocument: async () => ({ identifier: `owned-preload-${++script}` }),
			removeScriptToEvaluateOnNewDocument: async () => {},
			evaluate: async () => {
				userAgentRequested.resolve();
				if (options.failUserAgent) throw new Error("Owned peer failed during late initialization");
				return "Owned fixture user agent";
			},
			viewport: () => viewport,
			setViewport: async (value: typeof viewport) => { viewport = value; },
			emulateFocusedPage: async () => {},
			goto: async (destination: string) => {
				if (new URL(destination).hostname !== "owned-fixture.invalid") throw new Error("Non-owned navigation refused");
				url = destination;
				return null;
			},
			close: async () => {
				const session = this.cdp();
				try { await session.send("Target.closeTarget", { targetId: target.id }); }
				finally { await session.detach(); }
			},
		}) as unknown as Page;
		const peer = { page, userAgentRequested, url: () => url };
		this.#pagePeers.set(target.id, peer);
		target.allowClose.resolve();
		return peer;
	}

	browser(): Browser {
		let connected = true;
		const targetObjects = (): Target[] => [...this.targets.values()].filter(target => target.present).map(target => ({
			_targetId: target.id,
			type: () => "page", url: () => this.#pagePeers.get(target.id)?.url() ?? "about:blank",
			page: async () => { target.pageRequested.resolve(); return await target.ready.promise; },
		}) as unknown as Target);
		return {
			get connected() { return connected; },
			wsEndpoint: () => `owned-fixture:${this.owner}`,
			targets: targetObjects,
			target: () => ({ createCDPSession: async () => this.cdp() }),
			waitForTarget: async (predicate: (target: Target) => boolean) => {
				const target = targetObjects().find(predicate);
				if (!target) throw new Error("Fixture target did not exist");
				return target;
			},
			disconnect: () => { connected = false; },
		} as unknown as Browser;
	}

	cdp(): CDPSession {
		const session = new EventEmitter();
		this.#sessions.add(session);
		let downloads = false;
		return Object.assign(session, {
			send: async (method: string, parameters?: { targetId?: string; downloadPath?: string }) => {
				if (method === "Target.createTarget") {
					const target = this.newTarget();
					this.created.resolve(target);
					return { targetId: target.id };
				}
				if (method === "Target.setDiscoverTargets") return {};
				if (method === "Target.getTargets") return {
					targetInfos: [...this.targets.values()].filter(target => target.present).map(target => ({ targetId: target.id })),
				};
				if (["WebMCP.enable", "OMP.claimTarget", "Runtime.enable", "Network.enable"].includes(method)) return {};
				if (method === "Browser.setDownloadBehavior") {
					if (!parameters?.downloadPath?.startsWith(this.root + path.sep)) throw new Error("Non-owned download path refused");
					downloads = true;
					return {};
				}
				if (method !== "Target.closeTarget" || !parameters?.targetId) throw new Error(`Unexpected fixture CDP method: ${method}`);
				const target = this.targets.get(parameters.targetId);
				if (!target) throw new Error("Fixture refused to close an unknown target");
				target.closeAttempts++;
				target.closeRequested.resolve();
				await target.allowClose.promise;
				try {
					if (target.unconfirmed) return { success: false };
					target.present = false;
					for (const listener of this.#sessions) listener.emit("Target.targetDestroyed", { targetId: target.id });
					return { success: true };
				} finally { target.closeFinished.resolve(); }
			},
			detach: async () => {
				if (downloads && this.#downloadDetach) {
					const gate = this.#downloadDetach;
					gate.active = true;
					gate.entered.resolve();
					await gate.allow.promise;
					gate.active = false;
					gate.finished.resolve();
				}
				this.#sessions.delete(session);
			},
		}) as unknown as CDPSession;
	}

	start(code: string, signal?: AbortSignal, owner = this.owner, onText?: (text: string) => void): Promise<RunOutcome> {
		this.#owners.add(owner);
		let stdout = "";
		const run = executeInVmContext({
			sessionKey: owner, sessionId: owner, ownerId: owner,
			cwd: this.root, session: this.session, filename: "[owned-native-lifetime].js", code,
			runState: { signal, onText: text => { stdout += text; onText?.(text); } },
		}).then<RunOutcome, RunOutcome>(
			() => ({ ok: true, stdout }),
			error => ({ ok: false, error: error instanceof Error ? error : new Error(String(error)), stdout }),
		);
		this.#runs.push(run);
		return run;
	}

	async tab(options: { name?: string; owner?: string; persist?: boolean; borrowed?: boolean; controller?: recording.RecordingController } = {}): Promise<WorkerTabSession> {
		const target = this.newTarget();
		target.allowClose.resolve();
		const worker = new OwnedTabWorker(options.controller);
		this.workers.push(worker);
		const browser: registry.PuppeteerBrowserHandle = options.borrowed
			? { ...this.handle, key: `${this.owner}-borrowed-${target.id}`, kind: { kind: "connected", cdpUrl: "owned-fixture:borrowed" }, sharedDaemon: undefined, refCount: 2 }
			: this.handle;
		if (!options.borrowed) registry.holdBrowser(browser);
		const tab: WorkerTabSession = {
			name: options.name ?? `tab-${crypto.randomUUID()}`, browser, targetId: target.id,
			backend: "worker", worker: worker.handle(), state: "alive",
			info: { targetId: target.id, url: "about:blank", title: "Owned native fixture", viewport: { width: 2, height: 2 } },
			pending: new Map(), kindTag: options.borrowed ? "connected" : "headless",
			ownsPage: !options.borrowed, ownerSessionId: options.owner ?? this.owner,
			persist: options.persist ?? false, lastActivityAt: Date.now(), frozen: false,
			uploadDir: path.join(this.root, "never-created-uploads"),
		};
		this.tabs.add(tab);
		this.#workersByTab.set(tab, worker);
		supervisor.getTabsMapForTest().set(tab.name, tab);
		if (tab.ownsPage) await recordSharedTarget(this.scope, tab.targetId);
		return tab;
	}

	claimCode(tab: WorkerTabSession): string {
		return `await __omp_prelude__("ownedNativeFixture", ${JSON.stringify({ name: tab.name })})`;
	}

	workerFor(tab: WorkerTabSession): OwnedTabWorker {
		const worker = this.#workersByTab.get(tab);
		if (!worker) throw new Error("Fixture refused a non-owned tab worker");
		return worker;
	}

	observeRecording(controller: recording.RecordingController): void {
		this.controllers.add(controller);
		const finished = Promise.withResolvers<void>();
		this.#recordingFinished.set(controller, finished);
		const realClose = controller.close.bind(controller);
		const close = spyOn(controller, "close").mockImplementation((...args) => {
			const operation = realClose(...args);
			this.#recordingClosures.add(operation);
			void operation.finally(() => {
				this.#recordingClosures.delete(operation);
				finished.resolve();
			}).catch(() => undefined);
			return operation;
		});
		this.#restores.push(() => close.mockRestore());
	}

	recordingFinished(controller: recording.RecordingController): Promise<void> {
		const finished = this.#recordingFinished.get(controller);
		if (!finished) throw new Error("Fixture refused a non-owned recording");
		return finished.promise;
	}

	assertOnlyOwnedManagedTabs(): void {
		for (const tab of supervisor.getTabsMapForTest().values()) {
			if (!this.tabs.has(tab as WorkerTabSession)) throw new Error("Refusing a bulk operation with non-fixture tabs present");
		}
	}

	async recordedTargets(): Promise<string[]> {
		const barrier = `barrier-${crypto.randomUUID()}`;
		await recordSharedTarget(this.scope, barrier);
		await forgetSharedTarget(this.scope, barrier);
		const file = path.join(daemonRuntimeDir(this.root), `${this.scope.daemonName}.targets`, `${process.pid}.json`);
		try {
			const record: unknown = await Bun.file(file).json();
			if (typeof record !== "object" || record === null || !("targets" in record) || !Array.isArray(record.targets)) {
				throw new Error("Invalid owned target record");
			}
			return record.targets.filter((id): id is string => typeof id === "string");
		} catch (error) {
			if (isEnoent(error)) return [];
			throw error;
		}
	}

	async dispose(): Promise<void> {
		this.cancelled.abort(new Error("Owned fixture cleanup"));
		this.encoder.finish.resolve();
		for (const source of this.frameSources) source.allowStop.resolve();
		this.#downloadDetach?.allow.resolve();
		for (const target of this.targets.values()) {
			target.ready.reject(new Error("Owned fixture released its initialization gate"));
			target.allowClose.resolve();
		}
		try {
			await Promise.allSettled([...this.#owners].map(owner => disposeVmContextsByOwner(owner)));
			await Promise.allSettled(this.#runs);
			await Promise.allSettled(this.#acquisitions);
			for (const tab of this.tabs) await supervisor.releaseTab(tab.name, { expectedTab: tab }).catch(() => undefined);
			for (const worker of this.workers) worker.terminate();
			await hostTurn();
			for (const controller of this.controllers) void controller.close().catch(() => undefined);
			await Promise.allSettled(this.#recordingClosures);
			await hostTurn();
			for (const target of this.targets.values()) await forgetSharedTarget(this.scope, target.id);
			for (const handle of this.#additionalHandles) await registry.releaseBrowser(handle, { kill: false });
			await fs.rm(daemonRuntimeDir(this.root), { recursive: true, force: true });
			await fs.rm(this.root, { recursive: true, force: true });
		} finally {
			for (const restore of this.#restores.reverse()) restore();
		}
	}
}
