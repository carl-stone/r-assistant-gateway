import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const hopByHopHeaders = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);
const connectionTokens = (value: string | null | undefined): string[] =>
	(value ?? "")
		.split(",")
		.map((token) => token.trim().toLowerCase())
		.filter(Boolean);

const target = new URL(
	process.env.POSIT_CAPTURE_TARGET ?? "http://127.0.0.1:10532",
);
const outputDirectory = process.env.POSIT_CAPTURE_OUTPUT_DIR;
const labelFile = process.env.POSIT_CAPTURE_LABEL_FILE;
const port = Number(process.env.POSIT_CAPTURE_PORT ?? "10533");

if (!outputDirectory || !labelFile || !Number.isInteger(port)) {
	throw new Error(
		"Set POSIT_CAPTURE_OUTPUT_DIR and POSIT_CAPTURE_LABEL_FILE; POSIT_CAPTURE_PORT must be an integer.",
	);
}

await mkdir(outputDirectory, { recursive: true });
let sequence = 0;
for (const filename of await readdir(outputDirectory)) {
	const match = /^(\d+)-.*\.json$/.exec(filename);
	if (match?.[1]) sequence = Math.max(sequence, Number(match[1]));
}
const safeLabel = async (): Promise<string> => {
	const label = await readFile(labelFile, "utf8").catch(() => "unlabeled");
	return (
		label
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "") || "unlabeled"
	);
};

const server = createServer(async (request, response) => {
	try {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body = Buffer.concat(chunks);
		const inboundUrl = request.url ?? "/";
		const requestUrl = new URL(inboundUrl, target);
		if (
			!inboundUrl.startsWith("/") ||
			inboundUrl.startsWith("//") ||
			inboundUrl.includes("\\") ||
			requestUrl.origin !== target.origin
		) {
			response.writeHead(400, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					error: {
						message:
							"The capture proxy accepts origin-form request targets only.",
						type: "invalid_capture_target",
					},
				}),
			);
			return;
		}
		if (
			request.method === "POST" &&
			requestUrl.pathname.endsWith("/responses")
		) {
			const label = await safeLabel();
			let captured = body.toString("utf8");
			try {
				captured = `${JSON.stringify(JSON.parse(captured), null, 2)}\n`;
			} catch {
				// Keep malformed traffic byte-for-byte for diagnosis.
			}
			while (true) {
				sequence += 1;
				const filename = `${String(sequence).padStart(4, "0")}-${label}.json`;
				try {
					await writeFile(path.join(outputDirectory, filename), captured, {
						flag: "wx",
						mode: 0o600,
					});
					break;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				}
			}
		}

		const requestHopByHopHeaders = new Set([
			...hopByHopHeaders,
			...connectionTokens(request.headers.connection),
		]);
		const headers = new Headers();
		for (const [name, value] of Object.entries(request.headers)) {
			if (
				value !== undefined &&
				!["content-length", "host"].includes(name) &&
				!requestHopByHopHeaders.has(name)
			) {
				headers.set(name, Array.isArray(value) ? value.join(", ") : value);
			}
		}
		const upstreamInit: RequestInit = {
			method: request.method ?? "GET",
			headers,
			redirect: "manual",
		};
		if (body.length > 0) upstreamInit.body = body;
		const upstream = await fetch(requestUrl, upstreamInit);
		const responseHopByHopHeaders = new Set([
			...hopByHopHeaders,
			...connectionTokens(upstream.headers.get("connection")),
			"content-encoding",
			"content-length",
		]);
		const responseHeaders: Record<string, string | string[]> = {};
		upstream.headers.forEach((value, name) => {
			if (name !== "set-cookie" && !responseHopByHopHeaders.has(name)) {
				responseHeaders[name] = value;
			}
		});
		const setCookies = (
			upstream.headers as Headers & { getSetCookie?: () => string[] }
		).getSetCookie?.();
		if (setCookies && setCookies.length > 0) {
			responseHeaders["set-cookie"] = setCookies;
		} else {
			const setCookie = upstream.headers.get("set-cookie");
			if (setCookie) responseHeaders["set-cookie"] = setCookie;
		}
		response.writeHead(upstream.status, responseHeaders);
		if (upstream.body) {
			for await (const chunk of upstream.body)
				response.write(Buffer.from(chunk));
			response.end();
		} else {
			response.end();
		}
	} catch (error) {
		response.writeHead(502, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				error: {
					message: error instanceof Error ? error.message : String(error),
					type: "capture_proxy_error",
				},
			}),
		);
	}
});

await new Promise<void>((resolve, reject) => {
	server.once("error", reject);
	server.listen(port, "127.0.0.1", () => {
		server.off("error", reject);
		resolve();
	});
});
console.log(`Capture proxy listening at http://127.0.0.1:${port}/v1`);

const close = (): void => {
	server.close(() => process.exit(0));
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
