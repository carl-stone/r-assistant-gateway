# Interfaces around Posit Assistant

These notes describe the boundaries observed with Posit Assistant 1.3.0 in
RStudio and 1.3.1 in Positron. Both use the OpenAI Responses wire format with
the OpenAI provider; each IDE has its own Assistant integration.

## System map

```text
RStudio rsession
    ⇅ JSON-RPC over the Assistant process's stdin/stdout
Posit Assistant backend
    ⇅ OpenAI-compatible HTTP: GET /v1/models, POST /v1/responses
r-assistant-gateway
    ⇅ Codex Responses HTTP authenticated with ChatGPT OAuth
ChatGPT/Codex
```

The gateway participates only in the bottom two HTTP connections. It neither
sees nor implements the RStudio–Assistant JSON-RPC connection. Positron’s
Assistant extension uses the same bottom two HTTP connections, with its own
IDE integration above them.

## 1. RStudio ↔ Posit Assistant

RStudio launches the Assistant backend and exchanges JSON-RPC requests and
notifications with it over standard input and output. The observed handshake is
`protocol/getVersion`. Assistant sends its client version, a protocol version,
and capabilities; RStudio returns its version, protocol version, and
capabilities.

The installed Assistant 1.3.0 bundle declares `11.0` in `pai/bin/protocol.json`
and sends it as `clientProtocolVersion`. This version belongs only to the
RStudio–Assistant integration. It covers IDE-facing operations such as reading
workspace files, inspecting or executing an R session, opening documents, and
showing UI state.

A changed integration protocol might alter what context or tools Assistant can
obtain from RStudio. The number itself does not determine whether the gateway
works.

### Positron ↔ Posit Assistant

Positron hosts Posit Assistant as an extension. Its OpenAI provider constructs
a client with `apiMode: "responses"` and selects `.responses(model)`. The
separate OpenAI Compatible provider defaults to Chat Completions. No
RStudio JSON-RPC adapter is required for Positron.

## 2. Posit Assistant ↔ `/responses`

Assistant assembles the model conversation and uses its embedded OpenAI
serializer to make HTTP requests. When its OpenAI base URL is the gateway's
`http://127.0.0.1:10532/v1`, the important routes are:

- `GET /v1/models` for model discovery;
- `POST /v1/responses` for generation; and
- a streamed Responses event body for the result.

A request can contain `model`, `input`, tools, function-call results, reasoning,
images, files, prompt-cache controls, and streaming options. It contains no
RStudio integration protocol version. This inbound HTTP body is the gateway's
Posit-facing compatibility boundary.

## 3. Gateway ↔ ChatGPT/Codex

The gateway adapts Assistant's request to the Responses contract accepted by
the ChatGPT/Codex OAuth endpoint. It removes known incompatible fields, expands
locally remembered continuation items when necessary, and otherwise preserves
supported content. The OAuth runtime handles authentication, transport, model
discovery, and the response stream.

This outbound request contract—not RStudio's integration protocol—is the other
compatibility boundary.

## What version information means

| Information | Meaning for this gateway |
| --- | --- |
| RStudio version | Capture-environment provenance |
| RStudio–Assistant protocol | Capture-environment provenance |
| Posit Assistant version | Useful indication of which request builder is installed |
| Embedded `@ai-sdk/openai` version | Useful indication of serializer behavior |
| Captured `/responses` bodies | Direct evidence of the Posit-facing wire format |
| Codex request contract | Direct evidence of accepted outbound fields |
| OAuth runtime version | Direct dependency for authentication and transport behavior |
| Gateway adapter revision | Internal implementation marker; not a Responses API version |

For example, protocol 12 with an unchanged `/responses` body would not break the
gateway. Conversely, protocol 11 with a changed Assistant serializer could.

## Reverse-engineering rule of thumb

Identify each transport separately, capture data at the boundary under study,
and treat surrounding version numbers as provenance rather than proof of wire
compatibility. Raw model requests can contain prompts, local paths, file
contents, and reasoning, so use synthetic data and sanitize captures before
committing them.

## Positron compatibility evidence (2026-09-05)

Compared the installed Positron Assistant 1.3.1 `dist/extension.js` with
`dist/server/main.js` from the official
[RStudio Assistant 1.3.0 archive](https://cdn.posit.co/posit-ai/assistant-rstudio-1.3.0.zip).
The archive SHA-256 matched Posit’s manifest:
`52b9ba2ea26c3f8726fd6488aeb1dea0662500ca7021fec9268606c6a3644e97`.

Both bundles embed OpenAI SDK 3.0.88. Their Responses event schemas, model
classes, and `doStream()` methods match structurally after removing source
locations and normalizing minified identifiers. That comparison preserves
operators, string literals, property names, and syntax structure, but does not
prove equivalence of every renamed binding or external helper. The maintainer
subsequently confirmed successful live use in Positron, including Astra after
adding its custom model entry. No gateway protocol changes were needed.

The compared handlers cover text deltas, output items, function and custom
tool calls, reasoning summaries, completion/incomplete/failed responses,
errors, usage, and the same unknown-event fallback. The RStudio golden corpus
remains RStudio-specific evidence; it is not a Positron traffic capture.

### Model discovery limitation

Positron Assistant 1.3.1’s OpenAI model fetcher filters `/models` results:

```js
(id.startsWith("gpt-5") || id.startsWith("gpt-4") || id.startsWith("o")) &&
  !id.includes("instruct")
```

Consequently, `gpt-6-astra` is hidden despite being returned by the gateway.
Use `providers.openai.models.custom` to declare it without changing its ID or
the gateway. See the [README setup instructions](../README.md#a-model-is-missing-from-the-positron-selector).
This discovery behavior is separate from Responses stream compatibility.

### Doctor detection

`src/doctor.ts` reports RStudio’s Assistant under the existing `positAssistant`
key and Positron’s extension under `positronAssistant`. RStudio discovery uses
`pai/bin` locations or `POSIT_ASSISTANT_ROOT`. Positron discovery uses
`~/.positron/extensions` or `POSITRON_EXTENSIONS_DIR`, preferring the
`extensions.json` registry over directory scanning and ignoring `.obsolete`
entries. The package must identify itself as `posit.assistant`.

Either tested installation (RStudio 1.3.0 or Positron 1.3.1), together with the
pinned OAuth runtime, satisfies compatibility. Gateway health is still checked
separately and must pass for exit status zero. Installation detection does not
prove that an extension is enabled in the active IDE profile.

The Assistant versions above record tested configurations, not minimum version
requirements. Compatibility with older Assistant versions is unknown; a failed
version check alone does not demonstrate a protocol incompatibility.
