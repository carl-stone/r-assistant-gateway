import { CODEX_RESPONSES_REQUEST_FIELDS } from "./adapter.js";

const CODEX_SOURCE_PATH = "codex-rs/codex-api/src/common.rs";
const CODEX_COMMON_SOURCES = [
	`https://api.github.com/repos/openai/codex/contents/${CODEX_SOURCE_PATH}`,
	`https://raw.githubusercontent.com/openai/codex/main/${CODEX_SOURCE_PATH}`,
	`https://cdn.jsdelivr.net/gh/openai/codex@main/${CODEX_SOURCE_PATH}`,
] as const;

export type ContractCompatibility = {
	compatible: boolean;
	adapterFields: string[];
	upstreamFields: string[];
	availableUpstreamOnly: string[];
	unsupportedByUpstream: string[];
	source: string;
};

const stripRustComments = (source: string): string => {
	let result = "";
	let blockDepth = 0;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index] ?? "";
		const next = source[index + 1] ?? "";
		if (blockDepth > 0) {
			if (character === "/" && next === "*") {
				blockDepth += 1;
				result += "  ";
				index += 1;
			} else if (character === "*" && next === "/") {
				blockDepth -= 1;
				result += "  ";
				index += 1;
			} else {
				result += character === "\n" ? "\n" : " ";
			}
			continue;
		}
		if (inString) {
			result += character;
			if (escaped) {
				escaped = false;
			} else if (character === "\\") {
				escaped = true;
			} else if (character === '"') {
				inString = false;
			}
			continue;
		}
		if (character === '"') {
			inString = true;
			result += character;
			continue;
		}
		if (character === "/" && next === "/") {
			while (index < source.length && source[index] !== "\n") index += 1;
			result += "\n";
			continue;
		}
		if (character === "/" && next === "*") {
			blockDepth = 1;
			result += "  ";
			index += 1;
			continue;
		}
		result += character;
	}
	return result;
};

export const extractResponsesRequestFields = (source: string): string[] => {
	const cleaned = stripRustComments(source);
	const declaration = /^\s*pub\s+struct\s+ResponsesApiRequest\s*\{/m.exec(
		cleaned,
	);
	if (declaration?.index === undefined) {
		throw new Error("Could not find ResponsesApiRequest in Codex source.");
	}
	const declarationStart = declaration.index;
	const openingBrace = cleaned.indexOf("{", declarationStart);
	const attributeBlock = cleaned
		.slice(0, declarationStart)
		.match(/((?:\s*#\[[^\]]*\])+\s*)$/)?.[1];
	if (attributeBlock && /\brename_all\b/.test(attributeBlock)) {
		throw new Error("Unsupported serde rename_all on ResponsesApiRequest.");
	}

	let depth = 1;
	let closingBrace = -1;
	let inString = false;
	let escaped = false;
	for (let index = openingBrace + 1; index < cleaned.length; index += 1) {
		const character = cleaned[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (character === "\\") {
				escaped = true;
			} else if (character === '"') {
				inString = false;
			}
			continue;
		}
		if (character === '"') {
			inString = true;
		} else if (character === "{") {
			depth += 1;
		} else if (character === "}") {
			depth -= 1;
			if (depth === 0) {
				closingBrace = index;
				break;
			}
		}
	}
	if (closingBrace < 0) {
		throw new Error("ResponsesApiRequest has no closing brace.");
	}

	const fields: string[] = [];
	let attributes = "";
	for (const line of cleaned
		.slice(openingBrace + 1, closingBrace)
		.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("#[")) {
			if (!trimmed.endsWith("]")) {
				throw new Error("Multiline field attributes are not supported.");
			}
			attributes += trimmed;
			continue;
		}
		const field = /^\s*pub\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line);
		if (!field?.[1]) {
			if (trimmed.startsWith("pub ")) {
				throw new Error(
					`Could not parse ResponsesApiRequest field: ${trimmed}`,
				);
			}
			if (trimmed) attributes = "";
			continue;
		}
		if (/\bflatten\b/.test(attributes)) {
			throw new Error("Unsupported serde flatten on ResponsesApiRequest.");
		}
		if (!/\bskip\b|\bskip_serializing\b/.test(attributes)) {
			const renamed =
				/\brename\s*=\s*"([^"]+)"/.exec(attributes)?.[1] ??
				/\brename\s*\(\s*serialize\s*=\s*"([^"]+)"/.exec(attributes)?.[1];
			if (/\brename\b/.test(attributes) && !renamed) {
				throw new Error(`Could not parse serde rename for ${field[1]}.`);
			}
			fields.push(renamed ?? field[1]);
		}
		attributes = "";
	}
	if (fields.length === 0) {
		throw new Error("ResponsesApiRequest contains no parseable fields.");
	}
	return fields;
};

export const checkCurrentCodexContract = async (
	request: typeof fetch = fetch,
): Promise<ContractCompatibility> => {
	const token = process.env.GITHUB_TOKEN;
	const failures: string[] = [];
	for (const source of CODEX_COMMON_SOURCES) {
		try {
			const response = await request(source, {
				headers: {
					Accept: source.includes("api.github.com")
						? "application/vnd.github.raw+json"
						: "text/plain",
					"User-Agent": "r-assistant-gateway-contract-check",
					...(token && source.includes("api.github.com")
						? { Authorization: `Bearer ${token}` }
						: {}),
				},
				signal: AbortSignal.timeout(15_000),
			});
			if (!response.ok) {
				failures.push(`${source}: HTTP ${response.status}`);
				continue;
			}
			const upstreamFields = extractResponsesRequestFields(
				await response.text(),
			);
			const adapterFields = [...CODEX_RESPONSES_REQUEST_FIELDS];
			const availableUpstreamOnly = upstreamFields.filter(
				(field) =>
					!adapterFields.includes(field as (typeof adapterFields)[number]),
			);
			const unsupportedByUpstream = adapterFields.filter(
				(field) => !upstreamFields.includes(field),
			);
			return {
				compatible: unsupportedByUpstream.length === 0,
				adapterFields,
				upstreamFields,
				availableUpstreamOnly,
				unsupportedByUpstream,
				source,
			};
		} catch (error) {
			failures.push(
				`${source}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	throw new Error(`Codex contract check failed. ${failures.join("; ")}`);
};
