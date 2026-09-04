# Interfaces around Posit Assistant

These notes describe the boundaries observed with Posit Assistant 1.3.0 in
RStudio. They distinguish RStudio integration from the OpenAI Responses wire
format used by this gateway.

## System map

```text
RStudio rsession
    ⇅ JSON-RPC over the Assistant process's stdin/stdout
Posit Assistant backend
    ⇅ OpenAI-compatible HTTP: GET /v1/models, POST /v1/responses
posit-codex-gateway
    ⇅ Codex Responses HTTP authenticated with ChatGPT OAuth
ChatGPT/Codex
```

The gateway participates only in the bottom two HTTP connections. It neither
sees nor implements the RStudio–Assistant JSON-RPC connection.

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
