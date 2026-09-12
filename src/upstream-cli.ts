import { chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { adaptResponsesBody, isJsonObject } from "./adapter.js";
import {
	createStderrDiagnosticLogger,
	type DiagnosticLogger,
	extractUsage,
} from "./diagnostics.js";

const DEFAULT_PORT = 10532;

const UPSTREAM_RUNTIME_DIRECTORY_VARIABLE = "OPENAI_OAUTH_INTERNAL_RUNTIME_DIR";
const GATEWAY_RUNTIME_DIRECTORY_VARIABLE =
	"R_ASSISTANT_GATEWAY_INTERNAL_RUNTIME_DIR";

export const brandUpstreamCliText = (text: string): string => {
	const help =
		text.startsWith("Free OpenAI API access with your ChatGPT account.") &&
		text.includes("\nUsage\n");
	const updateGuidance = text.replace(
		/A newer version of (?:@carl-stone\/)?openai-oauth is available: ([^\n]+)\.\nRun `npx (?:@carl-stone\/)?openai-oauth@latest` to use the newest version\./g,
		"A newer pinned OAuth runtime is available: $1. Install an r-assistant-gateway release that supports it instead of upgrading the runtime directly.",
	);
	const branded = help
		? updateGuidance
				.replaceAll(
					"npx @carl-stone/openai-oauth@latest",
					"npx r-assistant-gateway@latest",
				)
				.replaceAll("npx openai-oauth@latest", "npx r-assistant-gateway@latest")
		: updateGuidance;
	return branded
		.replace(
			"Free OpenAI API access with your ChatGPT account.",
			"Use Posit Assistant in RStudio or Positron with your ChatGPT account.",
		)
		.replaceAll("npx openai-oauth stop", "npx r-assistant-gateway stop")
		.replaceAll("npx openai-oauth logs", "npx r-assistant-gateway logs")
		.replaceAll("npx openai-oauth login", "npx r-assistant-gateway login")
		.replaceAll(
			"npx @carl-stone/openai-oauth stop",
			"npx r-assistant-gateway stop",
		)
		.replaceAll(
			"npx @carl-stone/openai-oauth logs",
			"npx r-assistant-gateway logs",
		)
		.replaceAll(
			"npx @carl-stone/openai-oauth login",
			"npx r-assistant-gateway login",
		)
		.replace(
			"Start with `npx openai-oauth`",
			"Start with `npx r-assistant-gateway`",
		)
		.replace(
			"Start with `npx @carl-stone/openai-oauth`",
			"Start with `npx r-assistant-gateway`",
		)
		.replaceAll("Proxy port. Default: 10531.", "Proxy port. Default: 10532.")
		.replace("Default: stateless.", "Default: memory in r-assistant-gateway.")
		.replace(
			"  npx r-assistant-gateway@latest login [options]",
			"  npx r-assistant-gateway@latest login [options]\n  npx r-assistant-gateway@latest doctor",
		)
		.replace(
			"  --login-timeout-ms <ms>    Login timeout. Default: 300000",
			"  --login-timeout-ms <ms>    Login timeout. Default: 300000\n  --diagnostics              Emit adapter metadata to stderr.",
		)
		.replace(/Show version \([^)]+\)/g, "Show gateway version");
};

const installCliOutputBranding = (): void => {
	const log = console.log.bind(console);
	const info = console.info.bind(console);
	const warn = console.warn.bind(console);
	const error = console.error.bind(console);
	const branded = (values: unknown[]): unknown[] =>
		values.map((value) =>
			typeof value === "string" ? brandUpstreamCliText(value) : value,
		);
	console.log = (...values) => log(...branded(values));
	console.info = (...values) => info(...branded(values));
	console.warn = (...values) => warn(...branded(values));
	console.error = (...values) => error(...branded(values));
};

export const resolveGatewayRuntimeDirectory = (): string => {
	const override = process.env[GATEWAY_RUNTIME_DIRECTORY_VARIABLE];
	if (override) return override;
	if (process.platform === "darwin") {
		return path.join(
			os.homedir(),
			"Library",
			"Application Support",
			"r-assistant-gateway",
		);
	}
	if (process.platform === "win32") {
		return path.join(
			process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
			"r-assistant-gateway",
		);
	}
	return path.join(
		process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"),
		"r-assistant-gateway",
	);
};

export const prepareUpstreamCliArgv = (
	argv: string[],
): { argv: string[]; diagnostics: boolean } => {
	const diagnostics =
		argv.includes("--diagnostics") ||
		process.env.R_ASSISTANT_GATEWAY_DIAGNOSTICS === "1";
	const forwarded = argv.filter((argument) => argument !== "--diagnostics");
	const first = forwarded[0];
	const serves =
		first === undefined || first === "serve" || first.startsWith("-");
	const hasPort = forwarded.some(
		(argument) => argument === "--port" || argument.startsWith("--port="),
	);
	if (serves && !hasPort) forwarded.push("--port", String(DEFAULT_PORT));
	const hasResponsesState = forwarded.some(
		(argument) =>
			argument === "--responses-state" ||
			argument.startsWith("--responses-state="),
	);
	if (serves && !hasResponsesState) {
		forwarded.push("--responses-state", "memory");
	}
	return { argv: forwarded, diagnostics };
};

const toBodyText = async (
	input: Parameters<typeof fetch>[0],
	init: Parameters<typeof fetch>[1],
): Promise<string | undefined> => {
	if (typeof init?.body === "string") return init.body;
	if (init?.body instanceof Blob) return init.body.text();
	if (init?.body instanceof ArrayBuffer) {
		return new TextDecoder().decode(init.body);
	}
	if (ArrayBuffer.isView(init?.body)) {
		return new TextDecoder().decode(
			new Uint8Array(
				init.body.buffer,
				init.body.byteOffset,
				init.body.byteLength,
			),
		);
	}
	if (input instanceof Request && init?.body === undefined && input.body) {
		return input.clone().text();
	}
	return undefined;
};

const adaptedFetchInput = async (
	input: Parameters<typeof fetch>[0],
	init: Parameters<typeof fetch>[1],
	logger?: DiagnosticLogger,
): Promise<
	| {
			input: Parameters<typeof fetch>[0];
			init: Parameters<typeof fetch>[1];
			requestId: string;
			model?: string | undefined;
			unresolvedReplayState: boolean;
	  }
	| undefined
> => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	const method = (
		init?.method ?? (input instanceof Request ? input.method : "GET")
	).toUpperCase();
	if (method !== "POST" || !url.pathname.endsWith("/responses")) {
		return undefined;
	}

	const bodyText = await toBodyText(input, init);
	if (bodyText === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		return undefined;
	}
	if (!isJsonObject(parsed)) return undefined;

	const adapted = adaptResponsesBody(parsed);
	// The OAuth runtime expands known memory-state references before this fetch.
	// Any reference still present here is unresolved and must not lose context.
	const unresolvedReplayState =
		typeof parsed.previous_response_id === "string" ||
		(Array.isArray(parsed.input) &&
			parsed.input.some(
				(item) =>
					isJsonObject(item) &&
					item.type === "item_reference" &&
					typeof item.id === "string",
			));
	const headers = new Headers(
		init?.headers ?? (input instanceof Request ? input.headers : undefined),
	);
	headers.delete("content-length");
	const requestId = crypto.randomUUID();
	const model =
		typeof adapted.body.model === "string" ? adapted.body.model : undefined;
	logger?.({
		type: "responses_request",
		requestId,
		model,
		removedFieldPaths: adapted.removedFieldPaths,
		promptCacheBreakpointCount: adapted.promptCacheBreakpointCount,
	});

	const nextInit = {
		...init,
		method,
		headers,
		body: JSON.stringify(adapted.body),
	};
	return input instanceof Request
		? {
				input: new Request(input, nextInit),
				init: undefined,
				requestId,
				model,
				unresolvedReplayState,
			}
		: { input, init: nextInit, requestId, model, unresolvedReplayState };
};

export const installUpstreamFetchAdapter = (
	logger?: DiagnosticLogger,
): (() => void) => {
	const upstreamFetch = globalThis.fetch.bind(globalThis);
	const safeLogger: DiagnosticLogger | undefined = logger
		? (event) => {
				try {
					logger(event);
				} catch {
					// Diagnostics must never alter gateway traffic.
				}
			}
		: undefined;
	globalThis.fetch = async (input, init) => {
		const startedAt = Date.now();
		const adapted = await adaptedFetchInput(input, init, safeLogger);
		if (adapted?.unresolvedReplayState) {
			const response = Response.json(
				{
					error: {
						message:
							"Continuation state is unavailable. Start a new Posit Assistant conversation; the gateway may have restarted or evicted older state.",
						type: "invalid_request_error",
						code: "response_state_not_found",
					},
				},
				{ status: 400 },
			);
			safeLogger?.({
				type: "responses_response",
				requestId: adapted.requestId,
				model: adapted.model,
				status: response.status,
				durationMs: Date.now() - startedAt,
			});
			return response;
		}
		try {
			const response = await upstreamFetch(
				adapted?.input ?? input,
				adapted?.init ?? init,
			);
			if (adapted && safeLogger) {
				const event = {
					type: "responses_response" as const,
					requestId: adapted.requestId,
					model: adapted.model,
					status: response.status,
					durationMs: Date.now() - startedAt,
				};
				const contentType = response.headers.get("content-type") ?? "";
				if (!contentType.includes("text/event-stream")) {
					void response
						.clone()
						.json()
						.then((body) => safeLogger({ ...event, usage: extractUsage(body) }))
						.catch(() => safeLogger(event));
				} else {
					safeLogger(event);
				}
			}
			return response;
		} catch (error) {
			if (adapted && safeLogger) {
				safeLogger({
					type: "responses_error",
					requestId: adapted.requestId,
					model: adapted.model,
					status: 0,
					durationMs: Date.now() - startedAt,
				});
			}
			throw error;
		}
	};
	return () => {
		globalThis.fetch = upstreamFetch;
	};
};

const resolveUpstreamCliPath = (): string => {
	const require = createRequire(import.meta.url);
	const indexPath = require.resolve("openai-oauth");
	return path.join(path.dirname(indexPath), "cli.js");
};

export const resolveOauthAuthFilePaths = (argv: string[]): string[] => {
	const inlinePath = argv
		.find((argument) => argument.startsWith("--oauth-file="))
		?.slice("--oauth-file=".length);
	const optionIndex = argv.indexOf("--oauth-file");
	const explicitPath =
		inlinePath || (optionIndex >= 0 ? argv[optionIndex + 1] : undefined);
	if (explicitPath) return [explicitPath];
	return [
		...(process.env.CODEX_HOME
			? [path.join(process.env.CODEX_HOME, "auth.json")]
			: []),
		path.join(os.homedir(), ".codex", "auth.json"),
	].filter(
		(candidate, index, candidates) => candidates.indexOf(candidate) === index,
	);
};

export const runUpstreamCli = async (argv: string[]): Promise<void> => {
	const prepared = prepareUpstreamCliArgv(argv);
	const first = argv[0];
	const usesOAuth =
		first === undefined ||
		first === "serve" ||
		first === "login" ||
		(first.startsWith("-") && first !== "--help" && first !== "-h");
	if (usesOAuth && process.platform !== "win32") {
		for (const oauthFilePath of resolveOauthAuthFilePaths(argv)) {
			try {
				await chmod(oauthFilePath, 0o600);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	}
	process.env[UPSTREAM_RUNTIME_DIRECTORY_VARIABLE] =
		process.env[GATEWAY_RUNTIME_DIRECTORY_VARIABLE] ??
		resolveGatewayRuntimeDirectory();
	if (prepared.diagnostics) {
		process.env.R_ASSISTANT_GATEWAY_DIAGNOSTICS = "1";
	}
	process.argv = [
		process.argv[0] ?? process.execPath,
		process.argv[1] ?? "",
		...prepared.argv,
	];
	installCliOutputBranding();
	installUpstreamFetchAdapter(
		prepared.diagnostics ? createStderrDiagnosticLogger() : undefined,
	);
	// The installed upstream CLI remains responsible for parsing, login, process
	// lifecycle, logs, status, and stop. Its detached child re-enters this file.
	await import(pathToFileURL(resolveUpstreamCliPath()).href);
};
