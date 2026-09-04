import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGatewayRuntimeDirectory } from "./upstream-cli.js";

type PackageInfo = { version?: string };
type RuntimeInfo = { url?: string };

export const SUPPORTED_POSIT_ASSISTANT_VERSION = "1.3.0";
export const SUPPORTED_OPENAI_OAUTH_VERSION = "2.0.0-memory.2";

const readJson = async <T>(file: string): Promise<T | undefined> => {
	try {
		return JSON.parse(await readFile(file, "utf8")) as T;
	} catch {
		return undefined;
	}
};

const packageRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const require = createRequire(import.meta.url);

const resolveOAuthPackageJson = (): string | undefined => {
	for (const packageName of ["openai-oauth", "@carl-stone/openai-oauth"]) {
		try {
			let directory = path.dirname(require.resolve(packageName));
			while (directory !== path.dirname(directory)) {
				const candidate = path.join(directory, "package.json");
				if (existsSync(candidate)) return candidate;
				directory = path.dirname(directory);
			}
		} catch {
			// Try the next install layout.
		}
	}
	return undefined;
};

const positAssistantRoots = (): string[] => {
	if (process.env.POSIT_ASSISTANT_ROOT) {
		return [process.env.POSIT_ASSISTANT_ROOT];
	}
	if (process.platform === "win32") {
		return [
			path.join(
				process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
				"rstudio",
				"pai",
				"bin",
			),
			path.join(
				process.env.PROGRAMDATA ?? "C:\\ProgramData",
				"rstudio",
				"pai",
				"bin",
			),
		];
	}
	return [
		path.join(
			process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
			"rstudio",
			"pai",
			"bin",
		),
		path.join("/etc", "rstudio", "pai", "bin"),
	];
};

export const runDoctor = async () => {
	const roots = positAssistantRoots();
	let positRoot = roots[0] ?? "";
	let posit: PackageInfo | undefined;
	for (const candidate of roots) {
		const candidatePackage = await readJson<PackageInfo>(
			path.join(candidate, "package.json"),
		);
		if (candidatePackage) {
			positRoot = candidate;
			posit = candidatePackage;
			break;
		}
	}

	const oauthPackageJson = resolveOAuthPackageJson();
	const [gateway, oauth, runtime] = await Promise.all([
		readJson<PackageInfo>(path.join(packageRoot, "package.json")),
		oauthPackageJson == null
			? Promise.resolve(undefined)
			: readJson<PackageInfo>(oauthPackageJson),
		readJson<RuntimeInfo>(
			path.join(resolveGatewayRuntimeDirectory(), "runtime.json"),
		),
	]);

	let healthUrl = "http://127.0.0.1:10532/health";
	if (typeof runtime?.url === "string") {
		try {
			healthUrl = new URL("/health", runtime.url).href;
		} catch {
			// Fall back to the default gateway address for malformed stale state.
		}
	}
	const health = await fetch(healthUrl, {
		signal: AbortSignal.timeout(2_000),
	})
		.then(async (response) => {
			const body: unknown = await response.json().catch(() => undefined);
			const valid =
				typeof body === "object" &&
				body !== null &&
				"ok" in body &&
				body.ok === true &&
				"replay_state" in body &&
				body.replay_state === "memory";
			return {
				reachable: response.ok && valid,
				status: response.status,
				body,
				url: healthUrl,
				...(response.ok && !valid
					? { error: "Unexpected gateway health response." }
					: {}),
			};
		})
		.catch(() => ({ reachable: false, url: healthUrl }));

	const positVersion = posit?.version ?? "not installed";
	const oauthVersion = oauth?.version ?? "unknown";
	return {
		gatewayVersion: gateway?.version ?? "unknown",
		openaiOauthVersion: oauthVersion,
		positAssistant: {
			version: positVersion,
			path: positRoot,
		},
		compatibility: {
			supported:
				positVersion === SUPPORTED_POSIT_ASSISTANT_VERSION &&
				oauthVersion === SUPPORTED_OPENAI_OAUTH_VERSION,
			expectedPositAssistantVersion: SUPPORTED_POSIT_ASSISTANT_VERSION,
			expectedOpenaiOauthVersion: SUPPORTED_OPENAI_OAUTH_VERSION,
		},
		localHealth: health,
	};
};
