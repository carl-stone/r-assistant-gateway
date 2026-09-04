import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	runDoctor,
	SUPPORTED_OPENAI_OAUTH_VERSION,
	SUPPORTED_POSIT_ASSISTANT_VERSION,
} from "../src/doctor.js";

let positRoot: string;
let runtimeRoot: string;
const originalPositRoot = process.env.POSIT_ASSISTANT_ROOT;
const originalRuntimeRoot =
	process.env.POSIT_CODEX_GATEWAY_INTERNAL_RUNTIME_DIR;

beforeEach(async () => {
	positRoot = await mkdtemp(path.join(os.tmpdir(), "posit-assistant-doctor-"));
	runtimeRoot = path.join(positRoot, "runtime");
	await mkdir(runtimeRoot);
	process.env.POSIT_ASSISTANT_ROOT = positRoot;
	process.env.POSIT_CODEX_GATEWAY_INTERNAL_RUNTIME_DIR = runtimeRoot;
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ ok: true, replay_state: "memory" })),
	);
});

afterEach(async () => {
	if (originalPositRoot === undefined) {
		delete process.env.POSIT_ASSISTANT_ROOT;
	} else {
		process.env.POSIT_ASSISTANT_ROOT = originalPositRoot;
	}
	if (originalRuntimeRoot === undefined) {
		delete process.env.POSIT_CODEX_GATEWAY_INTERNAL_RUNTIME_DIR;
	} else {
		process.env.POSIT_CODEX_GATEWAY_INTERNAL_RUNTIME_DIR = originalRuntimeRoot;
	}
	vi.unstubAllGlobals();
	await rm(positRoot, { recursive: true, force: true });
});

describe.sequential("doctor gateway compatibility", () => {
	test("ignores the unrelated RStudio integration protocol", async () => {
		await Promise.all([
			writeFile(
				path.join(positRoot, "package.json"),
				JSON.stringify({ version: SUPPORTED_POSIT_ASSISTANT_VERSION }),
			),
			writeFile(
				path.join(positRoot, "protocol.json"),
				JSON.stringify({ protocol: "99.0" }),
			),
		]);

		const report = await runDoctor();

		expect(report.positAssistant).toEqual({
			version: "1.3.0",
			path: positRoot,
		});
		expect(report.compatibility).toEqual({
			supported: true,
			expectedPositAssistantVersion: "1.3.0",
			expectedOpenaiOauthVersion: SUPPORTED_OPENAI_OAUTH_VERSION,
		});
		expect(report.localHealth).toMatchObject({ reachable: true, status: 200 });
	});

	test("reports an untested Posit Assistant version", async () => {
		await writeFile(
			path.join(positRoot, "package.json"),
			JSON.stringify({ version: "1.3.1" }),
		);

		const report = await runDoctor();

		expect(report.compatibility).toEqual({
			supported: false,
			expectedPositAssistantVersion: "1.3.0",
			expectedOpenaiOauthVersion: SUPPORTED_OPENAI_OAUTH_VERSION,
		});
	});

	test("rejects an unrelated HTTP service on the gateway port", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ ok: true })),
		);
		await writeFile(
			path.join(positRoot, "package.json"),
			JSON.stringify({ version: SUPPORTED_POSIT_ASSISTANT_VERSION }),
		);

		const report = await runDoctor();

		expect(report.localHealth).toMatchObject({
			reachable: false,
			error: "Unexpected gateway health response.",
		});
	});

	test("checks the active gateway URL from runtime state", async () => {
		await Promise.all([
			writeFile(
				path.join(positRoot, "package.json"),
				JSON.stringify({ version: SUPPORTED_POSIT_ASSISTANT_VERSION }),
			),
			writeFile(
				path.join(runtimeRoot, "runtime.json"),
				JSON.stringify({ url: "http://127.0.0.1:15432/v1" }),
			),
		]);

		const report = await runDoctor();

		expect(fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:15432/health",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(report.localHealth).toMatchObject({
			reachable: true,
			url: "http://127.0.0.1:15432/health",
		});
	});
});
