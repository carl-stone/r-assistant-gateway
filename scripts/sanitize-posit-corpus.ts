import { createHash } from "node:crypto";
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import path from "node:path";

const usage =
	"Usage: tsx scripts/sanitize-posit-corpus.ts <raw-dir> <output-dir> --media-root <synthetic-project-dir> [--exclude <filename>]...";
const args = process.argv.slice(2);
if (args.length < 2) throw new Error(usage);

const sourceDirectory = path.resolve(args[0] as string);
const outputDirectory = path.resolve(args[1] as string);
if (sourceDirectory === outputDirectory) {
	throw new Error("The raw and sanitized directories must be different.");
}

const excluded = new Set<string>();
let mediaRoot: string | undefined;
for (let index = 2; index < args.length; index += 1) {
	const argument = args[index];
	const value = args[index + 1];
	if (!value) throw new Error(`${usage}\nMissing value for ${argument}.`);
	if (argument === "--exclude") excluded.add(value);
	else if (argument === "--media-root" && !mediaRoot) {
		mediaRoot = path.resolve(value);
	} else {
		throw new Error(`${usage}\nUnknown or repeated argument: ${argument}`);
	}
	index += 1;
}
if (!mediaRoot) throw new Error(`${usage}\n--media-root is required.`);
const syntheticMediaRoot = mediaRoot;

const corpusManifest = JSON.parse(
	await readFile(path.join(syntheticMediaRoot, "..", "manifest.json"), "utf8"),
) as {
	developerPromptFingerprints?: {
		algorithm?: unknown;
		positAssistant?: unknown;
		safetyClassifier?: unknown;
	};
};
const promptFingerprints = corpusManifest.developerPromptFingerprints;
if (
	promptFingerprints?.algorithm !== "sha256" ||
	typeof promptFingerprints.positAssistant !== "string" ||
	!/^[a-f0-9]{64}$/i.test(promptFingerprints.positAssistant) ||
	typeof promptFingerprints.safetyClassifier !== "string" ||
	!/^[a-f0-9]{64}$/i.test(promptFingerprints.safetyClassifier)
) {
	throw new Error(
		"The corpus manifest has invalid developer-prompt fingerprints.",
	);
}

const filenames = (await readdir(sourceDirectory))
	.filter((filename) => filename.endsWith(".json"))
	.sort();
if (filenames.length === 0) {
	throw new Error(`No JSON captures found in ${sourceDirectory}.`);
}
for (const filename of excluded) {
	if (!filenames.includes(filename)) {
		throw new Error(`Excluded capture does not exist: ${filename}`);
	}
}

const captures = await Promise.all(
	filenames.map(async (filename) => ({
		filename,
		body: JSON.parse(
			await readFile(path.join(sourceDirectory, filename), "utf8"),
		) as Record<string, unknown>,
	})),
);
const includedCaptures = captures.filter(
	({ filename }) => !excluded.has(filename),
);

const visitStrings = (
	value: unknown,
	visitor: (value: string) => void,
): void => {
	if (typeof value === "string") {
		visitor(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) visitStrings(item, visitor);
		return;
	}
	if (typeof value === "object" && value !== null) {
		for (const item of Object.values(value)) visitStrings(item, visitor);
	}
};

const visitRecords = (
	value: unknown,
	visitor: (value: Record<string, unknown>) => void,
): void => {
	if (Array.isArray(value)) {
		for (const item of value) visitRecords(item, visitor);
		return;
	}
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		visitor(record);
		for (const item of Object.values(record)) visitRecords(item, visitor);
	}
};

const workspacePaths = new Set<string>();
for (const capture of includedCaptures) {
	if (!Array.isArray(capture.body.input)) continue;
	for (const item of capture.body.input) {
		if (
			typeof item === "object" &&
			item !== null &&
			(item as Record<string, unknown>).role === "developer"
		) {
			continue;
		}
		visitStrings(item, (value) => {
			for (const match of value.matchAll(
				/<working_directory>([^<]+)<\/working_directory>/g,
			)) {
				if (match[1]) workspacePaths.add(match[1]);
			}
		});
	}
}
if (workspacePaths.size !== 1) {
	throw new Error(
		`Expected one captured working directory, found ${workspacePaths.size}.`,
	);
}
const capturedWorkspace = [...workspacePaths][0] as string;
const sanitizedWorkspace = "/workspace/posit-golden-capture";

const expectedMediaAssets = [
	["image/png", "synthetic-plot.png"],
	["application/pdf", "synthetic-report.pdf"],
] as const;
const mediaAssets = new Map(
	await Promise.all(
		expectedMediaAssets.map(async ([mediaType, filename]) => {
			const bytes = await readFile(path.join(syntheticMediaRoot, filename));
			return [
				createHash("sha256").update(bytes).digest("hex"),
				{ filename, mediaType },
			] as const;
		}),
	),
);
const observedMedia = new Map<string, number>();
const verifyDataUrl = (value: string, filename: string): void => {
	const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
	const mediaType = match?.[1];
	const encoded = match?.[2];
	if (!mediaType || encoded === undefined) {
		throw new Error(`Unsupported data URL in ${filename}.`);
	}
	const bytes = Buffer.from(encoded, "base64");
	if (bytes.toString("base64") !== encoded) {
		throw new Error(`Non-canonical base64 data URL in ${filename}.`);
	}
	const hash = createHash("sha256").update(bytes).digest("hex");
	const asset = mediaAssets.get(hash);
	if (!asset || asset.mediaType !== mediaType) {
		throw new Error(
			`Data URL in ${filename} does not match an allowlisted synthetic asset.`,
		);
	}
	observedMedia.set(
		asset.filename,
		(observedMedia.get(asset.filename) ?? 0) + 1,
	);
};
for (const capture of includedCaptures) {
	visitRecords(capture.body, (record) => {
		const isMediaPart =
			record.type === "input_image" || record.type === "input_file";
		const mediaValue =
			record.type === "input_image"
				? record.image_url
				: record.type === "input_file"
					? record.file_data
					: undefined;
		if (
			isMediaPart &&
			(typeof mediaValue !== "string" || !/^data:/i.test(mediaValue))
		) {
			throw new Error(
				`Captured media must embed an allowlisted data URL in ${capture.filename}.`,
			);
		}
	});
	visitStrings(capture.body, (value) => {
		if (/^data:/i.test(value)) verifyDataUrl(value, capture.filename);
	});
}
for (const { filename } of mediaAssets.values()) {
	if (observedMedia.get(filename) !== 1) {
		throw new Error(
			`Expected exactly one captured copy of synthetic media asset: ${filename}`,
		);
	}
}

const promptCacheKeys = new Map<string, string>();
const opaqueIds = new Map<string, string>();
const encryptedReasoning = new Map<string, string>();
const opaqueIdCounters = new Map<string, number>();

const stablePromptCacheKey = (value: string): string => {
	const classifierSuffix = value.endsWith(":classifier") ? ":classifier" : "";
	const base = classifierSuffix
		? value.slice(0, -classifierSuffix.length)
		: value;
	let replacement = promptCacheKeys.get(base);
	if (!replacement) {
		replacement = `golden-conversation-${String(promptCacheKeys.size + 1).padStart(2, "0")}`;
		promptCacheKeys.set(base, replacement);
	}
	return `${replacement}${classifierSuffix}`;
};

const stableOpaqueId = (value: string): string => {
	let replacement = opaqueIds.get(value);
	if (replacement) return replacement;
	const prefix = value.slice(0, value.indexOf("_"));
	const next = (opaqueIdCounters.get(prefix) ?? 0) + 1;
	opaqueIdCounters.set(prefix, next);
	replacement = `${prefix}_golden_${String(next).padStart(3, "0")}`;
	opaqueIds.set(value, replacement);
	return replacement;
};

const opaqueReasoningSurrogate = (index: number): string => {
	const blocks: Buffer[] = [];
	for (let block = 0; blocks.length * 32 < 1024; block += 1) {
		blocks.push(
			createHash("sha256")
				.update(`posit-golden-reasoning:${index}:${block}`)
				.digest(),
		);
	}
	return Buffer.concat(blocks).subarray(0, 1024).toString("base64");
};

const sanitizeString = (value: string): string =>
	value
		.replaceAll(capturedWorkspace, sanitizedWorkspace)
		.replaceAll("GOLDEN_IMAGE_17.png", "synthetic-plot.png")
		.replaceAll("GOLDEN_PDF_23.pdf", "synthetic-report.pdf")
		.replace(
			/Today's date is: [^\n<]+/g,
			"Today's date is: Monday, January 15, 2024 at 12:00:00 PM UTC",
		)
		.replace(/os="Linux [^"]+"/g, 'os="Linux 0.0.0-golden"')
		.replace(/identifier="[^"]+"/g, 'identifier="golden-r-session"')
		.replace(
			/\b(?:rs|call|resp|msg|fc|item)_[A-Za-z0-9_-]{12,}\b/g,
			stableOpaqueId,
		);

const developerPromptFingerprints = new Map([
	[
		promptFingerprints.positAssistant,
		"<POSIT_ASSISTANT_DEVELOPER_PROMPT_1_3_0>",
	],
	[
		promptFingerprints.safetyClassifier,
		"<POSIT_ASSISTANT_SAFETY_CLASSIFIER_PROMPT_1_3_0>",
	],
]);
const knownDeveloperPromptPlaceholders = new Set(
	developerPromptFingerprints.values(),
);
const redactDeveloperPrompt = (
	body: Record<string, unknown>,
	filename: string,
): void => {
	let redacted = 0;
	if (!Array.isArray(body.input)) {
		throw new Error(`Request input is not an array in ${filename}.`);
	}
	for (const item of body.input) {
		if (
			typeof item !== "object" ||
			item === null ||
			(item as Record<string, unknown>).role !== "developer"
		) {
			continue;
		}
		const content = (item as Record<string, unknown>).content;
		if (!Array.isArray(content)) {
			throw new Error(`Developer content is not an array in ${filename}.`);
		}
		for (const part of content) {
			if (typeof part !== "object" || part === null) {
				throw new Error(`Unexpected developer content in ${filename}.`);
			}
			const record = part as Record<string, unknown>;
			const text = record.text;
			if (record.type !== "input_text" || typeof text !== "string") {
				throw new Error(`Unexpected developer content in ${filename}.`);
			}
			const normalizedPrompt = text.replace(
				/^The date is (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{2} \d{4}\.$/m,
				"The date is <DATE>.",
			);
			const replacement = knownDeveloperPromptPlaceholders.has(text)
				? text
				: developerPromptFingerprints.get(
						createHash("sha256").update(normalizedPrompt).digest("hex"),
					);
			if (!replacement) {
				throw new Error(`Unrecognized developer prompt in ${filename}.`);
			}
			record.text = replacement;
			redacted += 1;
		}
	}
	if (redacted !== 1) {
		throw new Error(
			`Expected one developer prompt in ${filename}, found ${redacted}.`,
		);
	}
};

const sanitizeValue = (value: unknown, key?: string): unknown => {
	if (typeof value === "string") {
		if (key === "prompt_cache_key") return stablePromptCacheKey(value);
		if (key === "encrypted_content") {
			let replacement = encryptedReasoning.get(value);
			if (!replacement) {
				replacement = opaqueReasoningSurrogate(encryptedReasoning.size + 1);
				encryptedReasoning.set(value, replacement);
			}
			return replacement;
		}
		return sanitizeString(value);
	}
	if (Array.isArray(value)) {
		return value.map((item) => sanitizeValue(item));
	}
	if (typeof value === "object" && value !== null) {
		const sanitized: Record<string, unknown> = Object.create(null);
		for (const [childKey, childValue] of Object.entries(value)) {
			sanitized[childKey] = sanitizeValue(childValue, childKey);
		}
		return sanitized;
	}
	return value;
};

const outputFiles: Array<{ filename: string; serialized: string }> = [];
for (const capture of includedCaptures) {
	redactDeveloperPrompt(capture.body, capture.filename);
	const sanitized = sanitizeValue(capture.body) as Record<string, unknown>;
	const searchableStrings: string[] = [];
	visitStrings(sanitized, (value) => {
		if (!value.startsWith("data:")) searchableStrings.push(value);
	});
	visitRecords(sanitized, (record) => {
		searchableStrings.push(...Object.keys(record));
	});
	const searchable = searchableStrings.join("\n");
	if (
		/(?:\/home\/|\/Users\/|[A-Z]:\\Users\\)/i.test(searchable) ||
		(capturedWorkspace !== sanitizedWorkspace &&
			searchable.includes(capturedWorkspace))
	) {
		throw new Error(`A local path remains in ${capture.filename}.`);
	}
	if (
		/\bsk-[A-Za-z0-9_-]{12,}\b|\bBearer\s+[A-Za-z0-9._-]{20,}/i.test(searchable)
	) {
		throw new Error(`Credential-like content remains in ${capture.filename}.`);
	}
	outputFiles.push({
		filename: capture.filename,
		serialized: `${JSON.stringify(sanitized, null, 2)}\n`,
	});
}

const markerFilename = ".sanitized-posit-corpus";
const markerFileHashes = Object.fromEntries(
	outputFiles.map(({ filename, serialized }) => [
		filename,
		createHash("sha256").update(serialized).digest("hex"),
	]),
);
const markerContents = `${JSON.stringify(
	{
		schemaVersion: 1,
		generator: "r-assistant-gateway sanitize-posit-corpus",
		files: markerFileHashes,
	},
	null,
	2,
)}\n`;
const outputParent = path.dirname(outputDirectory);
const outputBasename = path.basename(outputDirectory);
await mkdir(outputParent, { recursive: true });
const lockFile = path.join(outputParent, `.${outputBasename}.sanitize.lock`);
try {
	await writeFile(lockFile, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
} catch (error) {
	if ((error as NodeJS.ErrnoException).code === "EEXIST") {
		throw new Error(`Another sanitizer owns the output lock: ${lockFile}`);
	}
	throw error;
}

const validateOwnedDirectory = async (directory: string): Promise<void> => {
	const outputInfo = await lstat(directory);
	if (outputInfo.isSymbolicLink() || !outputInfo.isDirectory()) {
		throw new Error(`Output path is not a real directory: ${directory}`);
	}
	const entries = (await readdir(directory)).sort();
	if (entries.length === 0) return;
	const parsedMarker = JSON.parse(
		await readFile(path.join(directory, markerFilename), "utf8").catch(
			() => "null",
		),
	) as {
		files?: unknown;
		generator?: unknown;
		schemaVersion?: unknown;
	};
	if (
		parsedMarker.schemaVersion !== 1 ||
		parsedMarker.generator !== "r-assistant-gateway sanitize-posit-corpus" ||
		typeof parsedMarker.files !== "object" ||
		parsedMarker.files === null ||
		Array.isArray(parsedMarker.files) ||
		Object.values(parsedMarker.files).some(
			(hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash),
		)
	) {
		throw new Error(
			`Refusing to replace an unowned output directory: ${directory}`,
		);
	}
	const ownedFiles = parsedMarker.files as Record<string, string>;
	const ownedEntries = [markerFilename, ...Object.keys(ownedFiles)].sort();
	if (JSON.stringify(entries) !== JSON.stringify(ownedEntries)) {
		throw new Error(
			`Refusing to replace an output directory whose inventory changed: ${directory}`,
		);
	}
	for (const [filename, expectedHash] of Object.entries(ownedFiles)) {
		const actualHash = createHash("sha256")
			.update(await readFile(path.join(directory, filename)))
			.digest("hex");
		if (actualHash !== expectedHash) {
			throw new Error(`Refusing to replace modified output file: ${filename}`);
		}
	}
};

let temporaryDirectory: string | undefined;
let backupDirectory: string | undefined;
try {
	let outputExists = false;
	try {
		const outputInfo = await lstat(outputDirectory);
		outputExists = true;
		if (outputInfo.isSymbolicLink() || !outputInfo.isDirectory()) {
			throw new Error(
				`Output path is not a real directory: ${outputDirectory}`,
			);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	temporaryDirectory = await mkdtemp(
		path.join(outputParent, `.${outputBasename}.tmp-`),
	);
	await writeFile(
		path.join(temporaryDirectory, markerFilename),
		markerContents,
		{ mode: 0o644 },
	);
	for (const output of outputFiles) {
		await writeFile(
			path.join(temporaryDirectory, output.filename),
			output.serialized,
			{ mode: 0o644 },
		);
	}
	if (outputExists) {
		backupDirectory = path.join(
			outputParent,
			`.${outputBasename}.backup-${process.pid}-${Date.now()}`,
		);
		await rename(outputDirectory, backupDirectory);
		try {
			await validateOwnedDirectory(backupDirectory);
		} catch (error) {
			await rename(backupDirectory, outputDirectory);
			backupDirectory = undefined;
			throw error;
		}
	}
	try {
		await rename(temporaryDirectory, outputDirectory);
	} catch (error) {
		if (backupDirectory) {
			await rename(backupDirectory, outputDirectory);
			backupDirectory = undefined;
		}
		throw error;
	}
	if (backupDirectory) {
		try {
			await validateOwnedDirectory(backupDirectory);
		} catch (error) {
			await rename(outputDirectory, temporaryDirectory);
			await rename(backupDirectory, outputDirectory);
			backupDirectory = undefined;
			throw error;
		}
		await rm(backupDirectory, { recursive: true });
		backupDirectory = undefined;
	}
} finally {
	if (temporaryDirectory) {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
	await rm(lockFile, { force: true });
}

console.log(
	`Sanitized ${outputFiles.length} request captures into ${outputDirectory}; excluded ${excluded.size}; verified ${observedMedia.size} synthetic media assets.`,
);
