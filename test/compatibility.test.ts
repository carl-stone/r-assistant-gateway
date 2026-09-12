import { describe, expect, test } from "vitest";
import {
	checkCurrentCodexContract,
	extractResponsesRequestFields,
} from "../src/compatibility.js";

const fields = [
	"model",
	"instructions",
	"input",
	"tools",
	"tool_choice",
	"parallel_tool_calls",
	"reasoning",
	"store",
	"stream",
	"stream_options",
	"include",
	"service_tier",
	"prompt_cache_key",
	"text",
	"client_metadata",
];

describe("Codex contract compatibility", () => {
	test("extracts ResponsesApiRequest fields", () => {
		const source = `pub struct ResponsesApiRequest {\n${fields
			.map((field) => `    pub ${field}: Option<Value>,`)
			.join("\n")}\n}`;
		expect(extractResponsesRequestFields(source)).toEqual(fields);
	});

	test("ignores comments and resolves serde wire names", () => {
		const source = `
			pub struct ResponsesApiRequest {
				/*
				pub commented_out: Value,
				*/
				#[serde(rename = "wire_name")]
				pub rust_name: Value,
				#[serde(skip)]
				pub omitted: Value,
				#[serde(skip_serializing_if = "Option::is_none")]
				pub retained: Option<Value>, // pub fake: Value,
			}
		`;
		expect(extractResponsesRequestFields(source)).toEqual([
			"wire_name",
			"retained",
		]);
	});

	test("fails closed for unsupported struct-wide serde renaming", () => {
		expect(() =>
			extractResponsesRequestFields(`
				#[serde(rename_all = "camelCase")]
				pub struct ResponsesApiRequest {
					pub prompt_cache_key: Value,
				}
			`),
		).toThrow("rename_all");
	});

	test("reports compatible fields using an injected network response", async () => {
		const source = `pub struct ResponsesApiRequest {\n${fields
			.map((field) => `    pub ${field}: Value,`)
			.join("\n")}\n}`;
		const result = await checkCurrentCodexContract(
			async () => new Response(source),
		);
		expect(result.compatible).toBe(true);
		expect(result.availableUpstreamOnly).toEqual([]);
		expect(result.unsupportedByUpstream).toEqual([]);
	});

	test("accepts additive upstream fields that the adapter does not send", async () => {
		const source = `pub struct ResponsesApiRequest {\n${[
			...fields,
			"access_programs",
		]
			.map((field) => `    pub ${field}: Value,`)
			.join("\n")}\n}`;
		const result = await checkCurrentCodexContract(
			async () => new Response(source),
		);
		expect(result.compatible).toBe(true);
		expect(result.availableUpstreamOnly).toEqual(["access_programs"]);
		expect(result.unsupportedByUpstream).toEqual([]);
	});

	test("rejects adapter fields that Codex no longer accepts", async () => {
		const source = `pub struct ResponsesApiRequest {\n${fields
			.filter((field) => field !== "client_metadata")
			.map((field) => `    pub ${field}: Value,`)
			.join("\n")}\n}`;
		const result = await checkCurrentCodexContract(
			async () => new Response(source),
		);
		expect(result.compatible).toBe(false);
		expect(result.availableUpstreamOnly).toEqual([]);
		expect(result.unsupportedByUpstream).toEqual(["client_metadata"]);
	});

	test("falls back when the GitHub API is unavailable", async () => {
		const source = `pub struct ResponsesApiRequest {\n${fields
			.map((field) => `    pub ${field}: Value,`)
			.join("\n")}\n}`;
		let calls = 0;
		const result = await checkCurrentCodexContract(async (_input, init) => {
			calls += 1;
			expect(init?.signal).toBeInstanceOf(AbortSignal);
			return calls === 1
				? new Response("unavailable", { status: 503 })
				: new Response(source);
		});
		expect(calls).toBe(2);
		expect(result.source).toContain("raw.githubusercontent.com");
		expect(result.compatible).toBe(true);
	});
});
