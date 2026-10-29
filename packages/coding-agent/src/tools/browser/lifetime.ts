/** Native browser ownership protocol, negotiated before an Eval-owned open. */
export const BROWSER_EVAL_LIFETIME_VERSION = 1;

export interface BrowserCapabilities {
	version: typeof BROWSER_EVAL_LIFETIME_VERSION;
	evalLifetime: {
		supported: boolean;
		backends: readonly ["headless", "relay"];
		receiptVersion: typeof BROWSER_EVAL_LIFETIME_VERSION;
	};
}

/** Receipt issued only after native new-page ownership and its run drain are registered. */
export interface BrowserEvalOwnership {
	version: typeof BROWSER_EVAL_LIFETIME_VERSION;
	lifetime: "eval";
	ownerGeneration: string;
	leaseId: string;
	targetId: string;
	created: true;
	ownsPage: true;
}

export interface BrowserCleanupIssue {
	resource: "worker" | "target" | "recording" | "encoder" | "uploads" | "browser";
	state: "failed" | "unconfirmed";
	workerId?: string;
	targetId?: string;
	ownerGeneration?: string;
}

/** Wire-safe native acknowledgement; no tab names, URLs, credentials, or raw errors. */
export interface BrowserCleanupReport {
	version: typeof BROWSER_EVAL_LIFETIME_VERSION;
	targetId?: string;
	issues: BrowserCleanupIssue[];
}

/** A failed native close is never a successful release, even when its page is gone. */
export class BrowserCleanupError extends AggregateError {
	constructor(readonly issues: readonly BrowserCleanupIssue[], errors: readonly unknown[] = []) {
		super(errors, "Native browser cleanup failed or could not be confirmed");
		this.name = "BrowserCleanupError";
	}

	get uncertain(): boolean {
		return this.issues.some(issue => issue.state === "unconfirmed");
	}
}
