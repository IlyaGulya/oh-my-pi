{
	const validateOptions = (label, options) => {
		if (options === undefined) return {};
		if (options === null || typeof options !== "object" || Array.isArray(options)) {
			throw new TypeError(`${label}() expects an options object`);
		}
		return options;
	};
	const serializeFunction = (label, fn) => {
		const source = String(fn);
		if (source.includes("[native code]")) {
			throw new TypeError(
				`${label} cannot serialize a native or bound function; pass an arrow or function expression`,
			);
		}
		return source;
	};
	const encodeArg = (label, value) => {
		if (typeof value === "function") return { __omp_fn: serializeFunction(label, value) };
		if (value instanceof RegExp) return { __omp_re: { source: value.source, flags: value.flags } };
		return value;
	};
	const encodeArgs = (label, args) => {
		const trimmed = [...args];
		while (trimmed.length > 0 && trimmed[trimmed.length - 1] === undefined) trimmed.pop();
		return trimmed.map(value => encodeArg(label, value));
	};
	const invoke = async (action, options) => {
		const response = await globalThis.__omp_prelude__("browser", { ...options, action });
		if (response && typeof response.text === "string" && response.text.length > 0) {
			globalThis.__omp_log__("log", response.text);
		}
		return response && typeof response.details === "object" && response.details !== null ? response.details : {};
	};
	const callValue = async (name, chain, lease) => {
		const parameters = { name, chain };
		if (lease !== undefined) parameters.lease = lease;
		const details = await invoke("call", parameters);
		return details.value;
	};
	const capabilities = async () => {
		const details = await invoke("capabilities", {});
		const result = details.capabilities;
		if (!result || result.version !== 1 || !result.evalLifetime ||
			typeof result.evalLifetime.supported !== "boolean" || result.evalLifetime.receiptVersion !== 1 ||
			!Array.isArray(result.evalLifetime.backends)) {
			throw new Error("Browser host does not expose the native Eval lifetime contract");
		}
		return result;
	};
	const directMethods = [
		"url",
		"title",
		"goto",
		"back",
		"forward",
		"reload",
		"pushState",
		"frames",
		"dialog",
		"handleDialog",
		"setDialogs",
		"observe",
		"ariaSnapshot",
		"a11y",
		"webmcpList",
		"webmcpInvoke",
		"webmcpEvents",
		"screenshot",
		"diffScreenshot",
		"pdf",
		"extract",
		"click",
		"dblclick",
		"hover",
		"focus",
		"check",
		"uncheck",
		"keyDown",
		"keyUp",
		"mouseMove",
		"mouseDown",
		"mouseUp",
		"clickAt",
		"wheel",
		"highlight",
		"type",
		"fill",
		"press",
		"scroll",
		"drag",
		"scrollIntoView",
		"select",
		"uploadFile",
		"waitForUrl",
		"text",
		"html",
		"value",
		"attr",
		"count",
		"box",
		"styles",
		"isVisible",
		"isEnabled",
		"isChecked",
		"waitForText",
		"evaluate",
		"waitFor",
		"waitForSelector",
		"emulate",
		"devices",
		"clipboardRead",
		"clipboardWrite",
		"clipboardCopy",
		"clipboardPaste",
		"cookies",
		"setCookies",
		"clearCookies",
		"storage",
		"setStorage",
		"clearStorage",
		"saveState",
		"loadState",
		"addInitScript",
		"removeInitScript",
		"initScripts",
		"waitForDownload",
		"downloads",
		"console",
		"errors",
		"clearConsole",
		"traceStart",
		"traceStop",
		"profileStart",
		"profileStop",
		"metrics",
		"route",
		"unroute",
		"routes",
		"requests",
		"request",
		"clearRequests",
		"harStart",
		"harStop",
		"allowedDomains",
		"vitals",
		"reactEnable",
		"reactTree",
		"reactInspect",
		"reactRenders",
		"reactSuspense",
		"recordStart",
		"recordStop",
		"recordRestart",
		"recording",
	];
	const elementMethods = [
		"click",
		"dblclick",
		"check",
		"uncheck",
		"highlight",
		"type",
		"fill",
		"press",
		"hover",
		"focus",
		"select",
		"uploadFile",
		"scrollIntoView",
		"boundingBox",
		"isVisible",
		"isHidden",
		"text",
		"html",
		"value",
		"attr",
		"styles",
		"isEnabled",
		"isChecked",
		"evaluate",
	];
	const frameMethods = [
		"click",
		"fill",
		"type",
		"press",
		"text",
		"html",
		"value",
		"attr",
		"count",
		"isVisible",
		"ariaSnapshot",
		"evaluate",
		"waitFor",
		"waitForSelector",
		"screenshot",
	];
	const makeElement = (name, handleMethod, handleArgs, lease) => {
		const element = {};
		const renderedArgs = handleArgs.map(value => JSON.stringify(value)).join(", ");
		element.toString = () => `<element tab.${handleMethod}(${renderedArgs}) on ${name}>`;
		for (const method of elementMethods) {
			element[method] = (...args) =>
				callValue(name, [
					{ method: handleMethod, args: handleArgs },
					{ method, args: encodeArgs("tab helper argument", args) },
				], lease);
		}
		return Object.freeze(element);
	};
	const makeFrame = (name, selector, lease) => {
		const frame = {};
		frame.toString = () => `<frame tab.frame(${JSON.stringify(selector)}) on ${name}>`;
		for (const method of frameMethods) {
			frame[method] = (...args) =>
				callValue(name, [
					{ method: "frame", args: encodeArgs("tab helper argument", [selector]) },
					{ method, args: encodeArgs("frame helper argument", args) },
				], lease);
		}
		return Object.freeze(frame);
	};
	const makeTab = (name, ownership) => {
		const tab = {};
		Object.defineProperty(tab, "name", { value: name, enumerable: true });
		const lease = ownership?.leaseId;
		if (ownership) Object.defineProperty(tab, "ownership", { value: Object.freeze(ownership), enumerable: true });
		tab.toString = () => `<tab ${name}>`;
		for (const method of directMethods) {
			tab[method] = (...args) => callValue(name, [{ method, args: encodeArgs("tab helper argument", args) }], lease);
		}
		tab.id = id => makeElement(name, "id", encodeArgs("tab helper argument", [id]), lease);
		tab.ref = id => makeElement(name, "ref", encodeArgs("tab helper argument", [id]), lease);
		tab.frame = selector => makeFrame(name, selector, lease);
		tab.run = async (fnOrCode, options) => {
			if (typeof fnOrCode !== "function" && typeof fnOrCode !== "string") {
				throw new TypeError("tab.run() expects a function or code string");
			}
			if (typeof fnOrCode === "function" && Array.isArray(options)) {
				throw new TypeError(
					"tab.run() expects an options object; pass the function's arguments as { args: [...] }: tab.run(async ({ page }, url) => …, { args: [url] })",
				);
			}
			const opts = validateOptions("tab.run", options);
			const args = opts.args ?? [];
			if (typeof fnOrCode === "string" && (!Array.isArray(args) || args.length > 0)) {
				throw new TypeError("tab.run() passes args only to a function; a code string receives none");
			}
			if (!Array.isArray(args)) {
				throw new TypeError(
					"tab.run() args must be an array of the function's arguments after its scope: tab.run(async ({ page }, url) => …, { args: [url] })",
				);
			}
			const parameters = { name };
			if (lease !== undefined) parameters.lease = lease;
			if (opts.timeout !== undefined) parameters.timeout = opts.timeout;
			if (typeof fnOrCode === "function") {
				parameters.fn = serializeFunction("tab.run()", fnOrCode);
				parameters.args = encodeArgs("tab helper argument", args);
			} else {
				parameters.code = fnOrCode;
			}
			const details = await invoke("run", parameters);
			return details.value;
		};
		tab.close = async options => {
			const opts = validateOptions("tab.close", options);
			const parameters = { ...opts, name };
			if (lease !== undefined) parameters.lease = lease;
			await invoke("close", parameters);
		};
		return Object.freeze(tab);
	};
	globalThis.browser = Object.freeze({
		capabilities,
		async open(options) {
			if (typeof options === "string") {
				throw new TypeError(
					"browser.open() expects an options object; pass the URL inside it: browser.open({ url, name })",
				);
			}
			const opts = validateOptions("browser.open", options);
			if (opts.lifetime === "eval") {
				const support = await capabilities();
				if (!support.evalLifetime.supported) {
					throw new Error("Eval browser lifetime is not supported by this Eval surface");
				}
			}
			const details = await invoke("open", opts);
			if (opts.lifetime === "eval") {
				const receipt = details.ownership;
				if (!receipt || receipt.version !== 1 || receipt.lifetime !== "eval" ||
					receipt.created !== true || receipt.ownsPage !== true ||
					typeof receipt.ownerGeneration !== "string" || !receipt.ownerGeneration ||
					typeof receipt.leaseId !== "string" || !receipt.leaseId ||
					typeof receipt.targetId !== "string" || !receipt.targetId ||
					details.name !== (opts.name ?? "main") ||
					(details.browser !== "headless" && details.browser !== "relay")) {
					throw new Error("Browser host did not acknowledge ownership of this Eval's new native page");
				}
				return makeTab(details.name, receipt);
			}
			return makeTab(typeof details.name === "string" ? details.name : (opts.name ?? "main"));
		},
		tab(name = "main") {
			if (typeof name !== "string" || name.length === 0) {
				throw new TypeError("browser.tab() expects a tab name");
			}
			return makeTab(name);
		},
		async tabs() {
			const details = await invoke("tabs", {});
			return Array.isArray(details.value) ? details.value : [];
		},
		async targets(options) {
			const details = await invoke("targets", validateOptions("browser.targets", options));
			return Array.isArray(details.value) ? details.value : [];
		},
		async close(options) {
			await invoke("close", validateOptions("browser.close", options));
		},
	});
}
