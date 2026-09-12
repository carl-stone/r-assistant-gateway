import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { adaptResponsesBody } from "../src/adapter.js";

type CorpusRequest = {
	file: string;
	features: string[];
	kind: string;
	promptCacheBreakpoints: number;
	scenario: string;
	stage: string;
};

type CorpusManifest = {
	capture: {
		boundary: string;
		dataClassification: string;
		date: string;
		headersRecorded: boolean;
		responsesRecorded: boolean;
		platform: string;
		surface: string;
	};
	captureEnvironment: {
		aiSdkOpenai: string;
		model: string;
		positAssistant: string;
		provider: string;
		reasoningEffort: string;
		rstudio: string;
		rstudioProtocol: string;
	};
	developerPromptFingerprints: {
		algorithm: string;
		normalization: string;
		positAssistant: string;
		safetyClassifier: string;
	};
	excludedCaptures: Array<{ rawFile: string }>;
	projectFiles: Array<{ file: string; sha256: string }>;
	requests: CorpusRequest[];
	sanitization: string[];
	schemaVersion: number;
};

const corpusRoot = new URL("./corpus/posit-1.3.0/", import.meta.url);
const manifest = JSON.parse(
	await readFile(new URL("manifest.json", corpusRoot), "utf8"),
) as CorpusManifest;

const readRequest = async (entry: CorpusRequest) =>
	JSON.parse(await readFile(new URL(entry.file, corpusRoot), "utf8")) as Record<
		string,
		unknown
	>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const recordsIn = (value: unknown): Record<string, unknown>[] => {
	const records: Record<string, unknown>[] = [];
	const pending = [value];
	while (pending.length > 0) {
		const current = pending.pop();
		if (Array.isArray(current)) {
			pending.push(...current);
		} else if (isRecord(current)) {
			records.push(current);
			pending.push(...Object.values(current));
		}
	}
	return records;
};

const stringsIn = (value: unknown): string[] => {
	const strings: string[] = [];
	const pending = [value];
	while (pending.length > 0) {
		const current = pending.pop();
		if (typeof current === "string") strings.push(current);
		else if (Array.isArray(current)) pending.push(...current);
		else if (isRecord(current)) pending.push(...Object.values(current));
	}
	return strings;
};

const expectedAdaptedBody = (
	request: Record<string, unknown>,
): Record<string, unknown> => {
	const expected = structuredClone(request);
	delete expected.max_output_tokens;
	delete expected.prompt_cache_options;
	if (!Array.isArray(expected.input)) return expected;
	for (const item of expected.input) {
		if (!isRecord(item)) continue;
		let parts: unknown;
		if (
			typeof item.role === "string" &&
			["system", "developer", "user", "assistant"].includes(item.role)
		) {
			parts = item.content;
		} else if (
			item.type === "function_call_output" ||
			item.type === "custom_tool_call_output"
		) {
			parts = item.output;
		}
		if (!Array.isArray(parts)) continue;
		for (const part of parts) {
			if (isRecord(part)) delete part.prompt_cache_breakpoint;
		}
	}
	return expected;
};

const decodeDataUrl = (value: unknown, mediaType: string): Buffer => {
	expect(typeof value).toBe("string");
	const prefix = `data:${mediaType};base64,`;
	expect(value).toMatch(new RegExp(`^${prefix.replace("/", "\\/")}`));
	return Buffer.from((value as string).slice(prefix.length), "base64");
};

const crc32 = (bytes: Buffer): number => {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
};

const requestHasFeature = (
	request: Record<string, unknown>,
	feature: string,
): boolean => {
	const records = recordsIn(request);
	const strings = stringsIn(request);
	const text = strings.filter((value) => !value.startsWith("data:")).join("\n");
	const toolNames = Array.isArray(request.tools)
		? request.tools.flatMap((tool) =>
				isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [],
			)
		: [];
	switch (feature) {
		case "workspace-context":
			return text.includes("<workspace-context>");
		case "tools":
			return toolNames.length > 0;
		case "reasoning":
			return isRecord(request.reasoning);
		case "streaming":
			return request.stream === true;
		case "multi-turn-history":
			return records.some((record) => record.role === "assistant");
		case "encrypted-reasoning":
			return records.some(
				(record) => typeof record.encrypted_content === "string",
			);
		case "project-file-tool":
			return (
				toolNames.includes("read") &&
				(text.includes("analysis.R") || text.includes("missing-golden-404.txt"))
			);
		case "function-call":
			return records.some((record) => record.type === "function_call");
		case "structured-function-output":
			return records.some(
				(record) =>
					record.type === "function_call_output" &&
					Array.isArray(record.output),
			);
		case "r-session-context":
			return text.includes(
				'<language_session description="Current active language session"',
			);
		case "classifier":
			return text.includes("<POSIT_ASSISTANT_SAFETY_CLASSIFIER_PROMPT_1_3_0>");
		case "explicit-cache":
			return (
				isRecord(request.prompt_cache_options) &&
				request.prompt_cache_options.mode === "explicit"
			);
		case "r-console-result":
			return text.includes("[1] 5");
		case "input-image":
		case "vision":
			return records.some((record) => record.type === "input_image");
		case "data-url":
			return strings.some((value) => value.startsWith("data:"));
		case "input-file":
			return records.some((record) => record.type === "input_file");
		case "filename":
			return records.some((record) => typeof record.filename === "string");
		case "open-file-context":
			return text.includes("<open_files>");
		case "variable-types":
			return text.includes("capture_fit|lm");
		case "tool-error":
			return text.includes("missing-golden-404.txt");
		case "error-output":
			return text.includes("JSON-RPC error (-32602): File not found:");
		default:
			throw new Error(`No corpus feature validator exists for ${feature}.`);
	}
};

describe("sanitized Posit Assistant 1.3.0 request corpus", () => {
	test("has complete provenance, stable project assets, and no raw identifiers", async () => {
		expect(manifest.schemaVersion).toBe(2);
		expect(manifest.capture).toEqual({
			date: "2026-09-04",
			platform: "Linux x64",
			surface: "RStudio Posit Assistant",
			boundary: "POST /responses request body before gateway adaptation",
			headersRecorded: false,
			responsesRecorded: false,
			dataClassification: "synthetic",
		});
		expect(manifest.sanitization).toHaveLength(5);
		expect(manifest.excludedCaptures.map(({ rawFile }) => rawFile)).toEqual([
			"0010-07-file-mention-context.json",
		]);
		expect(manifest.captureEnvironment).toEqual({
			positAssistant: "1.3.0",
			rstudioProtocol: "11.0",
			rstudio: "2026.08.2+200",
			aiSdkOpenai: "3.0.88",
			provider: "openai",
			model: "gpt-5.6-luna",
			reasoningEffort: "medium",
		});
		expect(manifest.developerPromptFingerprints).toEqual({
			algorithm: "sha256",
			normalization:
				"Replace the exact line beginning `The date is ` with `The date is <DATE>.` before hashing.",
			positAssistant:
				"1558970a45cb1361f8565bce26545bde7692999191f745384b14ad074af3cfc0",
			safetyClassifier:
				"398c7f1ba39546ae1a8767973f32002f14ab2fb311b7202188a7f036ae80cff4",
		});
		expect(
			manifest.requests.map(
				({ scenario, kind, stage }) => `${scenario}:${kind}:${stage}`,
			),
		).toEqual([
			"plain-chat:main:initial",
			"multi-turn-project-read:main:follow-up",
			"multi-turn-project-read:main:tool-result",
			"live-r-execute:main:initial",
			"live-r-execute:safety-classifier:tool-approval",
			"live-r-execute:main:tool-result",
			"image-attachment:main:initial",
			"pdf-attachment:main:initial",
			"open-editor-session-context:main:initial",
			"missing-file-tool-error:main:initial",
			"missing-file-tool-error:main:tool-result",
		]);
		expect(
			[
				...new Set(manifest.requests.flatMap(({ features }) => features)),
			].sort(),
		).toEqual(
			[
				"classifier",
				"data-url",
				"encrypted-reasoning",
				"error-output",
				"explicit-cache",
				"filename",
				"function-call",
				"input-file",
				"input-image",
				"multi-turn-history",
				"open-file-context",
				"project-file-tool",
				"r-console-result",
				"r-session-context",
				"reasoning",
				"streaming",
				"structured-function-output",
				"tool-error",
				"tools",
				"variable-types",
				"vision",
				"workspace-context",
			].sort(),
		);
		const ownershipMarker = JSON.parse(
			await readFile(
				new URL("requests/.sanitized-posit-corpus", corpusRoot),
				"utf8",
			),
		) as {
			files: Record<string, string>;
			generator: string;
			schemaVersion: number;
		};
		expect(ownershipMarker).toMatchObject({
			schemaVersion: 1,
			generator: "r-assistant-gateway sanitize-posit-corpus",
		});
		const requestFiles = (await readdir(new URL("requests/", corpusRoot)))
			.filter((filename) => filename.endsWith(".json"))
			.sort();
		expect(requestFiles).toEqual(
			manifest.requests.map(({ file }) => file.replace("requests/", "")).sort(),
		);
		expect(Object.keys(ownershipMarker.files).sort()).toEqual(requestFiles);
		for (const filename of requestFiles) {
			const bytes = await readFile(new URL(`requests/${filename}`, corpusRoot));
			expect(createHash("sha256").update(bytes).digest("hex"), filename).toBe(
				ownershipMarker.files[filename],
			);
		}
		for (const { rawFile } of manifest.excludedCaptures) {
			expect(requestFiles).not.toContain(rawFile);
		}

		for (const projectFile of manifest.projectFiles) {
			const bytes = await readFile(new URL(projectFile.file, corpusRoot));
			expect(createHash("sha256").update(bytes).digest("hex")).toBe(
				projectFile.sha256,
			);
		}

		for (const entry of manifest.requests) {
			const request = await readRequest(entry);
			expect(request.model, `${entry.file}:model`).toBe(
				manifest.captureEnvironment.model,
			);
			if (entry.kind === "main") {
				expect(request.reasoning, `${entry.file}:reasoning`).toMatchObject({
					effort: manifest.captureEnvironment.reasoningEffort,
				});
				expect(request.store, `${entry.file}:store`).toBe(false);
				expect(request.include, `${entry.file}:include`).toContain(
					"reasoning.encrypted_content",
				);
			} else {
				expect(entry.kind).toBe("safety-classifier");
				expect(request).not.toHaveProperty("reasoning");
			}
			for (const feature of entry.features) {
				expect(
					requestHasFeature(request, feature),
					`${entry.file}:${feature}`,
				).toBe(true);
			}
			const strings = stringsIn(request).filter(
				(value) => !value.startsWith("data:"),
			);
			const searchable = strings.join("\n");
			expect(searchable).not.toMatch(/\/home\/|\/Users\/|\\Users\\/i);
			expect(searchable).not.toContain("/Work/r-assistant-gateway");
			expect(searchable).not.toMatch(
				/7\.1\.9-arch|September 04|cb43a80e|\b(?:rs|call)_[A-Za-z0-9]{20,}\b/,
			);
			expect(request.prompt_cache_key).toMatch(
				/^golden-conversation-\d{2}(?::classifier)?$/,
			);
			for (const record of recordsIn(request)) {
				if (record.encrypted_content === undefined) continue;
				expect(record.encrypted_content, entry.file).toMatch(
					/^[A-Za-z0-9+/]+={0,2}$/,
				);
				const encryptedBytes = Buffer.from(
					record.encrypted_content as string,
					"base64",
				);
				expect(encryptedBytes.toString("base64"), entry.file).toBe(
					record.encrypted_content,
				);
				expect(encryptedBytes, entry.file).toHaveLength(1024);
				expect(new Set(encryptedBytes).size, entry.file).toBeGreaterThan(240);
			}
		}
	});

	test("adapts every captured body without changing supported payloads", async () => {
		for (const entry of manifest.requests) {
			const request = await readRequest(entry);
			const original = structuredClone(request);
			const markerCount = recordsIn(request).filter((record) =>
				Object.hasOwn(record, "prompt_cache_breakpoint"),
			).length;
			expect(markerCount, entry.file).toBe(entry.promptCacheBreakpoints);

			const adapted = adaptResponsesBody(request);
			const supportedRootKeys = Object.keys(request).filter(
				(key) => !["max_output_tokens", "prompt_cache_options"].includes(key),
			);
			expect(Object.keys(adapted.body), entry.file).toEqual(supportedRootKeys);
			for (const key of supportedRootKeys) {
				if (key !== "input") {
					expect(adapted.body[key], `${entry.file}:${key}`).toEqual(
						request[key],
					);
				}
			}
			expect(request, entry.file).toEqual(original);
			expect(adapted.body, entry.file).toEqual(expectedAdaptedBody(request));
			expect(adapted.promptCacheBreakpointCount, entry.file).toBe(markerCount);
			expect(adapted.removedFieldPaths, entry.file).toEqual([
				"$.*",
				"**.prompt_cache_breakpoint",
				"prompt_cache_options",
			]);
			expect(adapted.body, entry.file).not.toHaveProperty("max_output_tokens");
			expect(adapted.body, entry.file).not.toHaveProperty(
				"prompt_cache_options",
			);
			expect(
				recordsIn(adapted.body).some((record) =>
					Object.hasOwn(record, "prompt_cache_breakpoint"),
				),
				entry.file,
			).toBe(false);
		}
	});

	test("covers multi-turn, tools, R context, media, classifier, and error shapes", async () => {
		const loaded = new Map<string, Record<string, unknown>>();
		for (const entry of manifest.requests) {
			loaded.set(entry.file, await readRequest(entry));
		}

		const multiTurn = loaded.get(
			"requests/0002-02-project-file-tool.json",
		) as Record<string, unknown>;
		expect(JSON.stringify(multiTurn)).toContain("GOLDEN_PLAIN_OK");
		expect(
			recordsIn(multiTurn).find((record) => record.type === "reasoning"),
		).toMatchObject({
			id: "rs_golden_001",
		});

		for (const [file, expectedOutput] of [
			[
				"requests/0003-02-project-file-tool.json",
				"capture_mean <- mean(capture_data$value)",
			],
			["requests/0006-03-live-r-execute.json", "[1] 5\n"],
			[
				"requests/0012-08-missing-file-tool-error.json",
				"File not found: /workspace/posit-golden-capture/missing-golden-404.txt",
			],
		] as const) {
			const output = recordsIn(loaded.get(file)).find(
				(record) => record.type === "function_call_output",
			);
			const outputParts = output?.output;
			expect(Array.isArray(outputParts), file).toBe(true);
			if (!Array.isArray(outputParts))
				throw new Error(`Missing output: ${file}`);
			const outputText = outputParts
				.map((part) => (isRecord(part) ? part.text : undefined))
				.join("");
			expect(outputText, file).toContain(expectedOutput);
		}

		const classifier = loaded.get(
			"requests/0005-03-live-r-execute.json",
		) as Record<string, unknown>;
		expect(Object.keys(classifier)).toEqual([
			"model",
			"input",
			"max_output_tokens",
			"prompt_cache_key",
			"prompt_cache_options",
			"stream",
		]);
		expect(classifier.max_output_tokens).toBe(256);
		expect(classifier).not.toHaveProperty("tools");

		const imageRequest = loaded.get(
			"requests/0007-04-image-attachment.json",
		) as Record<string, unknown>;
		const image = recordsIn(imageRequest).find(
			(record) => record.type === "input_image",
		);
		const imageBytes = decodeDataUrl(image?.image_url, "image/png");
		expect(imageBytes).toEqual(
			await readFile(new URL("project/synthetic-plot.png", corpusRoot)),
		);
		expect(imageBytes.subarray(0, 8)).toEqual(
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		);
		const pngChunks: Array<{ data: Buffer; type: string }> = [];
		let pngOffset = 8;
		while (pngOffset < imageBytes.length) {
			const chunkLength = imageBytes.readUInt32BE(pngOffset);
			const typeOffset = pngOffset + 4;
			const dataOffset = typeOffset + 4;
			const crcOffset = dataOffset + chunkLength;
			expect(crcOffset + 4).toBeLessThanOrEqual(imageBytes.length);
			const type = imageBytes.toString("ascii", typeOffset, dataOffset);
			const data = imageBytes.subarray(dataOffset, crcOffset);
			expect(imageBytes.readUInt32BE(crcOffset), type).toBe(
				crc32(imageBytes.subarray(typeOffset, crcOffset)),
			);
			pngChunks.push({ data, type });
			pngOffset = crcOffset + 4;
		}
		expect(pngOffset).toBe(imageBytes.length);
		expect(pngChunks[0]?.type).toBe("IHDR");
		expect(pngChunks.some(({ type }) => type === "IDAT")).toBe(true);
		expect(pngChunks.at(-1)?.type).toBe("IEND");
		expect(imageBytes.readUInt32BE(16)).toBe(480);
		expect(imageBytes.readUInt32BE(20)).toBe(320);
		expect(imageBytes[24]).toBe(8);
		expect(imageBytes[25]).toBe(2);
		const imageScanlines = inflateSync(
			Buffer.concat(
				pngChunks.filter(({ type }) => type === "IDAT").map(({ data }) => data),
			),
		);
		const pngScanlineLength = 1 + 480 * 3;
		expect(imageScanlines).toHaveLength(320 * pngScanlineLength);
		for (let row = 0; row < 320; row += 1) {
			expect(
				imageScanlines[row * pngScanlineLength],
				`PNG row ${row}`,
			).toBeLessThanOrEqual(4);
		}

		const pdfRequest = loaded.get(
			"requests/0008-05-pdf-attachment.json",
		) as Record<string, unknown>;
		const pdf = recordsIn(pdfRequest).find(
			(record) => record.type === "input_file",
		);
		expect(pdf?.filename).toBe("synthetic-report.pdf");
		const pdfBytes = decodeDataUrl(pdf?.file_data, "application/pdf");
		expect(pdfBytes).toEqual(
			await readFile(new URL("project/synthetic-report.pdf", corpusRoot)),
		);
		const pdfText = pdfBytes.toString("ascii");
		expect(pdfText).toMatch(/^%PDF-1\.4\n/);
		expect(pdfText).toContain("(Document token: GOLDEN_PDF_23) Tj");
		expect(pdfText.match(/\d+ 0 obj\n/g)).toHaveLength(5);
		const startXref = /startxref\n(\d+)\n%%EOF\n$/.exec(pdfText);
		expect(startXref?.[1]).toBeDefined();
		const xrefOffset = Number(startXref?.[1]);
		expect(pdfText.slice(xrefOffset, xrefOffset + 4)).toBe("xref");
		const xref =
			/^xref\n0 6\n((?:\d{10} \d{5} [fn] \n){6})trailer\n<< \/Size 6 \/Root 1 0 R >>\n/.exec(
				pdfText.slice(xrefOffset),
			);
		expect(xref?.[1]).toBeDefined();
		const xrefEntries = xref?.[1]?.split("\n").slice(0, -1) ?? [];
		expect(xrefEntries).toHaveLength(6);
		expect(xrefEntries[0]).toBe("0000000000 65535 f ");
		for (let objectNumber = 1; objectNumber <= 5; objectNumber += 1) {
			const entry = /^(\d{10}) 00000 n $/.exec(xrefEntries[objectNumber] ?? "");
			expect(entry?.[1], `xref object ${objectNumber}`).toBeDefined();
			const objectOffset = Number(entry?.[1]);
			expect(
				pdfText.startsWith(`${objectNumber} 0 obj\n`, objectOffset),
				`xref object ${objectNumber}`,
			).toBe(true);
		}
		const stream = /<< \/Length (\d+) >>\nstream\n([\s\S]*?)endstream\n/.exec(
			pdfText,
		);
		expect(Buffer.byteLength(stream?.[2] ?? "", "ascii")).toBe(
			Number(stream?.[1]),
		);

		const editorContext = JSON.stringify(
			loaded.get("requests/0009-06-active-editor-selection.json"),
		);
		expect(editorContext).toContain("analysis.R (visible, active)");
		expect(editorContext).toContain("capture_fit|lm");
		expect(editorContext).toContain('identifier=\\"golden-r-session\\"');
		expect(editorContext).not.toContain("#3366CC");
	});
});
