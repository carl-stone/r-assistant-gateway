import { type ChildProcess, spawn } from "node:child_process";
import {
	cp,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const captureScript = path.join(
	repositoryRoot,
	"scripts/capture-posit-requests.ts",
);
const sanitizerScript = path.join(
	repositoryRoot,
	"scripts/sanitize-posit-corpus.ts",
);
const corpusRoot = path.join(repositoryRoot, "test/corpus/posit-1.3.0");

const listen = async (server: Server): Promise<number> => {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Test server did not acquire a TCP port.");
	}
	return address.port;
};

const reservePort = async (): Promise<number> => {
	const server = createServer();
	const port = await listen(server);
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	return port;
};

const startTypeScript = (
	script: string,
	args: string[],
	environment: NodeJS.ProcessEnv = {},
): ChildProcess =>
	spawn(process.execPath, ["--import", "tsx", script, ...args], {
		cwd: repositoryRoot,
		env: { ...process.env, ...environment },
		stdio: ["ignore", "pipe", "pipe"],
	});

const runTypeScript = async (
	script: string,
	args: string[],
): Promise<{ code: number | null; stderr: string; stdout: string }> => {
	const child = startTypeScript(script, args);
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
	child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
	const code = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", resolve);
	});
	return {
		code,
		stderr: Buffer.concat(stderr).toString(),
		stdout: Buffer.concat(stdout).toString(),
	};
};

const stopChild = async (child: ChildProcess): Promise<void> => {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	await new Promise<void>((resolve) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			resolve();
		}, 2_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolve();
		});
	});
};

const waitForProxy = async (port: number): Promise<void> => {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/ready`);
			if (response.ok) return;
		} catch {
			// The child has not started listening yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Capture proxy on port ${port} did not start.`);
};

const rawRequest = async (
	port: number,
	requestTarget: string,
	extraHeaders = "",
) =>
	new Promise<string>((resolve, reject) => {
		const chunks: Buffer[] = [];
		const socket = connect(port, "127.0.0.1", () => {
			socket.write(
				`GET ${requestTarget} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${extraHeaders}Connection: close\r\n\r\n`,
			);
		});
		socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		socket.once("error", reject);
		socket.once("end", () => resolve(Buffer.concat(chunks).toString()));
	});

const directorySnapshot = async (directory: string) => {
	const snapshot = new Map<string, Buffer>();
	for (const filename of (await readdir(directory)).sort()) {
		snapshot.set(filename, await readFile(path.join(directory, filename)));
	}
	return snapshot;
};

describe("golden corpus tooling", () => {
	test("captures concurrently without overwrite and stays on the configured origin", async () => {
		const temporaryRoot = await mkdtemp(
			path.join(tmpdir(), "posit-capture-proxy-test-"),
		);
		const rawDirectory = path.join(temporaryRoot, "raw");
		const labelFile = path.join(temporaryRoot, "label");
		await writeFile(labelFile, "concurrent\n");
		const upstreamPaths: string[] = [];
		const upstreamRequestHeaders: IncomingHttpHeaders[] = [];
		const upstream = createServer(async (request, response) => {
			for await (const _chunk of request) {
				// Consume request bodies before responding.
			}
			upstreamPaths.push(request.url ?? "");
			upstreamRequestHeaders.push(request.headers);
			if (request.url === "/headers") {
				response.writeHead(200, {
					connection: "x-remove-me",
					"set-cookie": ["first=one; Path=/", "second=two; Path=/"],
					"x-remove-me": "private-hop-value",
				});
				response.end("headers-ok");
				return;
			}
			if (request.url === "/gzip") {
				const compressed = gzipSync("decoded-ok");
				response.writeHead(200, {
					"content-encoding": "gzip",
					"content-length": compressed.length,
					"content-type": "text/plain",
				});
				response.end(compressed);
				return;
			}
			response.writeHead(200, { "content-type": "application/json" });
			response.end('{"ok":true}');
		});
		const upstreamPort = await listen(upstream);
		const proxyPorts = await Promise.all([reservePort(), reservePort()]);
		const proxies = proxyPorts.map((port) =>
			startTypeScript(captureScript, [], {
				POSIT_CAPTURE_LABEL_FILE: labelFile,
				POSIT_CAPTURE_OUTPUT_DIR: rawDirectory,
				POSIT_CAPTURE_PORT: String(port),
				POSIT_CAPTURE_TARGET: `http://127.0.0.1:${upstreamPort}`,
			}),
		);
		try {
			await Promise.all(proxyPorts.map(waitForProxy));
			await Promise.all(
				Array.from({ length: 20 }, async (_, index) => {
					const response = await fetch(
						`http://127.0.0.1:${proxyPorts[index % 2]}/v1/responses`,
						{
							body: JSON.stringify({ id: index, model: "gpt-test" }),
							headers: { "content-type": "application/json" },
							method: "POST",
						},
					);
					expect(response.status).toBe(200);
				}),
			);
			const captures = (await readdir(rawDirectory))
				.filter((filename) => filename.endsWith(".json"))
				.sort();
			expect(captures).toHaveLength(20);
			const capturedIds = new Set<number>();
			for (const filename of captures) {
				const body = JSON.parse(
					await readFile(path.join(rawDirectory, filename), "utf8"),
				) as { id: number };
				capturedIds.add(body.id);
				expect(
					(await stat(path.join(rawDirectory, filename))).mode & 0o777,
				).toBe(0o600);
			}
			expect(capturedIds.size).toBe(20);

			for (const requestTarget of [
				`http://127.0.0.1:${upstreamPort}/absolute`,
				"/\\example.com/escaped",
			]) {
				const response = await rawRequest(
					proxyPorts[0] as number,
					requestTarget,
				);
				expect(response).toContain("400 Bad Request");
				expect(response).toContain("invalid_capture_target");
			}
			expect(upstreamPaths).not.toContain("/absolute");
			expect(upstreamPaths).not.toContain("/escaped");

			const requestHeaderResponse = await rawRequest(
				proxyPorts[0] as number,
				"/request-headers",
				"Connection: x-secret\r\nX-Secret: do-not-forward\r\n",
			);
			expect(requestHeaderResponse).toContain("200 OK");
			const requestHeaderIndex = upstreamPaths.lastIndexOf("/request-headers");
			expect(
				upstreamRequestHeaders[requestHeaderIndex]?.["x-secret"],
			).toBeUndefined();

			const responseHeaderResponse = await fetch(
				`http://127.0.0.1:${proxyPorts[0]}/headers`,
			);
			expect(responseHeaderResponse.headers.get("x-remove-me")).toBeNull();
			expect(
				(
					responseHeaderResponse.headers as Headers & {
						getSetCookie?: () => string[];
					}
				).getSetCookie?.(),
			).toEqual(["first=one; Path=/", "second=two; Path=/"]);
			expect(await responseHeaderResponse.text()).toBe("headers-ok");

			const compressedResponse = await fetch(
				`http://127.0.0.1:${proxyPorts[0]}/gzip`,
			);
			expect(compressedResponse.headers.get("content-encoding")).toBeNull();
			expect(await compressedResponse.text()).toBe("decoded-ok");

			const previousMaximum = Math.max(
				...captures.map((filename) => Number(filename.slice(0, 4))),
			);
			await Promise.all(proxies.map(stopChild));
			const resumedPort = await reservePort();
			const resumedProxy = startTypeScript(captureScript, [], {
				POSIT_CAPTURE_LABEL_FILE: labelFile,
				POSIT_CAPTURE_OUTPUT_DIR: rawDirectory,
				POSIT_CAPTURE_PORT: String(resumedPort),
				POSIT_CAPTURE_TARGET: `http://127.0.0.1:${upstreamPort}`,
			});
			proxies.push(resumedProxy);
			await waitForProxy(resumedPort);
			const resumedResponse = await fetch(
				`http://127.0.0.1:${resumedPort}/v1/responses`,
				{
					body: '{"id":20,"model":"gpt-test"}',
					headers: { "content-type": "application/json" },
					method: "POST",
				},
			);
			expect(resumedResponse.status).toBe(200);
			const resumedCaptures = (await readdir(rawDirectory)).filter((filename) =>
				filename.endsWith(".json"),
			);
			expect(resumedCaptures).toHaveLength(21);
			expect(
				Math.max(
					...resumedCaptures.map((filename) => Number(filename.slice(0, 4))),
				),
			).toBeGreaterThan(previousMaximum);
		} finally {
			await Promise.all(proxies.map(stopChild));
			await new Promise<void>((resolve, reject) =>
				upstream.close((error) => (error ? reject(error) : resolve())),
			);
			await rm(temporaryRoot, { force: true, recursive: true });
		}
	}, 20_000);

	test("sanitizes atomically and refuses drift, untrusted media, or changed output", async () => {
		const temporaryRoot = await mkdtemp(
			path.join(tmpdir(), "posit-corpus-sanitizer-test-"),
		);
		const source = path.join(corpusRoot, "requests");
		const mediaRoot = path.join(corpusRoot, "project");
		const output = path.join(temporaryRoot, "output");
		try {
			const first = await runTypeScript(sanitizerScript, [
				source,
				output,
				"--media-root",
				mediaRoot,
			]);
			expect(first, first.stderr).toMatchObject({ code: 0 });
			expect(await directorySnapshot(output)).toEqual(
				await directorySnapshot(source),
			);

			const opaqueKeySource = path.join(temporaryRoot, "opaque-key-source");
			await cp(source, opaqueKeySource, { recursive: true });
			const opaqueRequestPath = path.join(
				opaqueKeySource,
				"0001-01-plain-chat.json",
			);
			const opaqueRequest = JSON.parse(
				await readFile(opaqueRequestPath, "utf8"),
			) as Record<string, unknown>;
			Object.defineProperty(opaqueRequest, "__proto__", {
				configurable: true,
				enumerable: true,
				value: { preserved: true },
				writable: true,
			});
			await writeFile(
				opaqueRequestPath,
				`${JSON.stringify(opaqueRequest, null, 2)}\n`,
			);
			const opaqueKeyOutput = path.join(temporaryRoot, "opaque-key-output");
			const opaqueKeyResult = await runTypeScript(sanitizerScript, [
				opaqueKeySource,
				opaqueKeyOutput,
				"--media-root",
				mediaRoot,
			]);
			expect(opaqueKeyResult, opaqueKeyResult.stderr).toMatchObject({
				code: 0,
			});
			const sanitizedOpaqueRequest = JSON.parse(
				await readFile(
					path.join(opaqueKeyOutput, "0001-01-plain-chat.json"),
					"utf8",
				),
			) as Record<string, unknown>;
			expect(Object.hasOwn(sanitizedOpaqueRequest, "__proto__")).toBe(true);
			expect(
				Object.getOwnPropertyDescriptor(sanitizedOpaqueRequest, "__proto__")
					?.value,
			).toEqual({ preserved: true });

			opaqueRequest["/home/example/private"] = true;
			await writeFile(
				opaqueRequestPath,
				`${JSON.stringify(opaqueRequest, null, 2)}\n`,
			);
			const privateKeyFailure = await runTypeScript(sanitizerScript, [
				opaqueKeySource,
				path.join(temporaryRoot, "private-key-output"),
				"--media-root",
				mediaRoot,
			]);
			expect(privateKeyFailure.code).not.toBe(0);
			expect(privateKeyFailure.stderr).toContain("A local path remains");

			const sanitizerLock = path.join(temporaryRoot, ".output.sanitize.lock");
			await writeFile(sanitizerLock, "other-process\n");
			const locked = await runTypeScript(sanitizerScript, [
				source,
				output,
				"--media-root",
				mediaRoot,
			]);
			expect(locked.code).not.toBe(0);
			expect(locked.stderr).toContain("owns the output lock");
			await rm(sanitizerLock);

			const badSource = path.join(temporaryRoot, "bad-source");
			await cp(source, badSource, { recursive: true });
			const firstRequestPath = path.join(badSource, "0001-01-plain-chat.json");
			const firstRequest = JSON.parse(
				await readFile(firstRequestPath, "utf8"),
			) as { input: Array<{ content: Array<{ text: string }> }> };
			const developerPart = firstRequest.input[0]?.content[0];
			if (!developerPart) throw new Error("Missing corpus developer prompt.");
			developerPart.text = "<CHANGED_DEVELOPER_PROMPT>";
			await writeFile(
				firstRequestPath,
				`${JSON.stringify(firstRequest, null, 2)}\n`,
			);
			const beforeFailure = await directorySnapshot(output);
			const promptFailure = await runTypeScript(sanitizerScript, [
				badSource,
				output,
				"--media-root",
				mediaRoot,
			]);
			expect(promptFailure.code).not.toBe(0);
			expect(promptFailure.stderr).toContain("Unrecognized developer prompt");
			expect(await directorySnapshot(output)).toEqual(beforeFailure);

			const mediaSource = path.join(temporaryRoot, "bad-media-source");
			await cp(source, mediaSource, { recursive: true });
			const imageRequestPath = path.join(
				mediaSource,
				"0007-04-image-attachment.json",
			);
			const imageRequest = await readFile(imageRequestPath, "utf8");
			expect(imageRequest).toContain("data:image/png;base64,i");
			await writeFile(
				imageRequestPath,
				imageRequest.replace(
					"data:image/png;base64,i",
					"data:image/png;base64,j",
				),
			);
			const mediaFailure = await runTypeScript(sanitizerScript, [
				mediaSource,
				path.join(temporaryRoot, "bad-media-output"),
				"--media-root",
				mediaRoot,
			]);
			expect(mediaFailure.code).not.toBe(0);
			expect(mediaFailure.stderr).toContain(
				"does not match an allowlisted synthetic asset",
			);

			const remoteMediaSource = path.join(temporaryRoot, "remote-media-source");
			await cp(source, remoteMediaSource, { recursive: true });
			const remoteImagePath = path.join(
				remoteMediaSource,
				"0007-04-image-attachment.json",
			);
			const remoteImageRequest = (
				await readFile(remoteImagePath, "utf8")
			).replace(
				/data:image\/png;base64,[A-Za-z0-9+/=]+/,
				"https://example.invalid/untrusted.png",
			);
			await writeFile(remoteImagePath, remoteImageRequest);
			const remoteMediaFailure = await runTypeScript(sanitizerScript, [
				remoteMediaSource,
				path.join(temporaryRoot, "remote-media-output"),
				"--media-root",
				mediaRoot,
			]);
			expect(remoteMediaFailure.code).not.toBe(0);
			expect(remoteMediaFailure.stderr).toContain(
				"must embed an allowlisted data URL",
			);

			await writeFile(path.join(output, "9999-unrelated.json"), "{}\n");
			const inventoryFailure = await runTypeScript(sanitizerScript, [
				source,
				output,
				"--media-root",
				mediaRoot,
			]);
			expect(inventoryFailure.code).not.toBe(0);
			expect(inventoryFailure.stderr).toContain("inventory changed");
			expect(
				await readFile(path.join(output, "9999-unrelated.json"), "utf8"),
			).toBe("{}\n");

			await rm(path.join(output, "9999-unrelated.json"));
			const ownedOutput = path.join(output, "0001-01-plain-chat.json");
			await writeFile(ownedOutput, `${await readFile(ownedOutput, "utf8")} `);
			const modifiedFailure = await runTypeScript(sanitizerScript, [
				source,
				output,
				"--media-root",
				mediaRoot,
			]);
			expect(modifiedFailure.code).not.toBe(0);
			expect(modifiedFailure.stderr).toContain("modified output file");
			expect(
				(await readdir(temporaryRoot)).filter((filename) =>
					/^\.output\.(?:backup|tmp|sanitize)/.test(filename),
				),
			).toEqual([]);
		} finally {
			await rm(temporaryRoot, { force: true, recursive: true });
		}
	}, 20_000);
});
