# posit-codex-gateway

Love Codex models, hate API prices? ☀️ 🌍 🌙
Use your existing ChatGPT/Codex subscription sign-in with Posit Assistant in RStudio.

`posit-codex-gateway` is a small local compatibility bridge between Posit
Assistant's OpenAI Responses client and ChatGPT/Codex. It uses
[`@carl-stone/openai-oauth`](https://github.com/carl-stone/openai-oauth) to sign
in with your ChatGPT account and translates Posit Assistant's requests into the
request contract accepted by ChatGPT/Codex.

It is intentionally only that bridge. It is not a general OpenAI proxy or an
API-key replacement for other applications.

> **Unofficial community project.** This project is not affiliated with,
> endorsed by, or supported by Posit or OpenAI.

## Before you start

You need:

- [Node.js 20 or newer](https://nodejs.org/en/download);
- RStudio 2026.04.0 or newer with Posit Assistant 1.3.0; and
- a ChatGPT/Codex Plus or Pro subscription.

The gateway uses your ChatGPT/Codex sign-in. You do not need an OpenAI API key.

## Quick start

With Node.js installed, run these commands in a Terminal window:

```sh
npm install --global posit-codex-gateway
posit-codex-gateway login
posit-codex-gateway
```

The last command keeps the gateway running in the foreground. Leave that
Terminal window open while you use Posit Assistant.

To run it in the background instead, use:

```sh
posit-codex-gateway --detach
```

### Connect Posit Assistant

In the Posit Assistant pane in RStudio, select **gear > Configure AI providers
> OpenAI**, then use:

| Setting | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:10532/v1` |
| API key | `local-gateway` |

`local-gateway` is only a non-secret placeholder required by the OpenAI setup
form. The gateway does not use it as an OpenAI API key; upstream requests use
your ChatGPT/Codex sign-in. A non-empty value also lets Posit Assistant discover
the models available through your account from the gateway.

## Start, check, and stop the gateway

These commands are useful when the gateway runs in the background:

```sh
posit-codex-gateway status
posit-codex-gateway logs --follow
posit-codex-gateway doctor
posit-codex-gateway stop
```

Run `posit-codex-gateway` again to start it in the foreground after stopping
it. The default port is `10532`, which matches the Posit Assistant URL above.
You can choose another port with, for example, `--port 10533`; if you do, change
the provider's base URL to match.

## What the gateway translates

Posit Assistant 1.3.0 uses the OpenAI Responses wire format. For current Codex
models it can send developer and user input, images and files, tool definitions,
function calls, structured function outputs, encrypted reasoning, and explicit
prompt-cache controls.

ChatGPT/Codex accepts most of that request directly. The gateway removes only
known incompatible fields:

- `prompt_cache_options`;
- `prompt_cache_breakpoint` markers on Posit's input content parts;
- `previous_response_id` and legacy prompt-cache retention fields; and
- any other root field outside the current Codex request contract, including
  Posit's `max_output_tokens`.

The model, messages, images, files, reasoning, tools, function calls and
structured results, cache key, and streaming response remain intact. The
adapter never mutates the request object supplied by its caller.

The OAuth runtime handles sign-in, token refresh, model discovery, upstream
transport, and server lifecycle. The gateway defaults its optional Responses
history to process-local memory so ID-based continuations can be resolved when
needed. That history is discarded whenever the gateway stops.

## Supported versions

Gateway 0.2.x is compatible with Posit Assistant 1.3.0, the Codex Responses
request contract around Codex CLI 0.153.x, and `@carl-stone/openai-oauth`
2.0.0-memory.2.

RStudio's release and its internal RStudio–Assistant JSON-RPC protocol are not
part of the gateway's wire contract. The golden corpus records them only as
capture provenance. See [the developer interface notes](dev/README.md) for the
three distinct boundaries.

## Troubleshooting

Run the read-only diagnostic report with:

```sh
posit-codex-gateway doctor
```

It reports the installed gateway, Posit Assistant, and OAuth runtime versions;
whether Posit Assistant 1.3.0 is installed; and whether the active local gateway
is healthy. It exits unsuccessfully if the tested software does not match or the
gateway is unreachable. It does not read conversations or credentials.

Common fixes:

- **RStudio cannot connect:** make sure the gateway is running and the base URL
  is exactly `http://127.0.0.1:10532/v1`.
- **The port is busy:** stop the other process, or start with
  `posit-codex-gateway --port <number>` and update the base URL.
- **Sign-in fails:** run `posit-codex-gateway login` again, then restart the
  gateway.
- **A conversation fails after restarting the gateway:** start a new Posit
  Assistant conversation. Temporary continuation state is cleared on restart.
- **`doctor` reports an unsupported version:** install Posit Assistant 1.3.0.
  For an administrator-managed or otherwise nonstandard installation, set
  `POSIT_ASSISTANT_ROOT` to its `pai/bin` directory before running `doctor`.
- **`doctor` reports an unexpected OAuth runtime:** reinstall the matching
  `posit-codex-gateway` release rather than upgrading its runtime directly.
- **The background gateway is not working:** run `status`, inspect `logs`, then
  use `stop` before starting it again.

## Privacy and network behavior

By default, the gateway listens only on your computer at `127.0.0.1`. It uses
the same host behavior as `openai-oauth`. An explicit non-loopback `--host` can
make the unauthenticated endpoint reachable by other computers; every client
that can reach it can use your ChatGPT/Codex subscription. Keep the default
unless that access is deliberate and protected by your network.

OAuth credentials and upstream transport are handled by the published OAuth
runtime. Recent Responses items are held only in the running process, with
default limits of 256 response-history entries and 2,000 items. They are never
persisted by the gateway and are discarded when it stops or restarts.

On POSIX systems, gateway startup and login restrict the selected OAuth
credential file to its owner (`0600`).

Diagnostics are off by default. If enabled with `--diagnostics`, they contain
metadata only: request ID, model, schema-only removed-field patterns, cache
breakpoint count, status, duration, and safely available token counts. Prompts,
conversation content, tool arguments and results, credentials, headers, auth
material, and reasoning content are not logged.

## Advanced CLI options

The gateway accepts the same public commands and options as its OAuth runtime,
including `login`, `--host`, `--port`, `--models`, `--codex-version`,
`--base-url`, OAuth overrides, `--no-open`, login timeout, `--detach`, `status`,
`logs`, `stop`, `--responses-state`, `--responses-max-responses`, and
`--responses-max-items`.

There are two intentional Posit defaults: port `10532` and process-local
Responses memory. You can override the port. Setting `--responses-state
stateless` disables continuation by response or item IDs, so `doctor` does not
consider that configuration healthy for Posit Assistant. `doctor` and
`--diagnostics` are specific to this gateway.

### OAuth runtime limitations

- Use an IPv4 host such as the default `127.0.0.1`. The pinned OAuth runtime
  does not correctly advertise an IPv6 host.
- Cancelling a request in the client may not stop the upstream generation. The
  pinned runtime does not yet propagate HTTP disconnects to its upstream fetch.
- The delegated runtime also exposes unadapted chat-completion and image routes.
  They are outside this gateway's supported surface; this is another reason to
  keep the listener on the default loopback address.

## Development

Start with [the interface and reverse-engineering notes](dev/README.md) to see
which traffic belongs to RStudio, Posit Assistant, the gateway, and Codex.

```sh
npm install
npm run verify
npm run check:contract
npm pack --dry-run
```

`npm run verify` performs typechecking, linting, unit tests, a TypeScript build,
and a detached end-to-end CLI test using a Posit Assistant 1.3.0-shaped request.
CI also performs an npm package dry run. A separate scheduled/manual workflow
verifies that every root field forwarded by the adapter remains accepted by
Codex. Dependabot watches npm and GitHub Actions dependencies.

The compact unit fixture follows the installed Posit Assistant 1.3.0 bundle,
which embeds `@ai-sdk/openai` 3.0.88, and the matching public
[`posit-dev/ai-lib`](https://github.com/posit-dev/ai-lib) OpenAI client and
wire-format tests. A separate
[sanitized golden corpus](test/corpus/posit-1.3.0/README.md) was captured from
actual RStudio traffic before gateway adaptation. It covers multi-turn history,
tools and structured results, live R context, PNG and PDF inputs, the safety
classifier, and a tool failure.

## Credits and license

This project uses
[`@carl-stone/openai-oauth`](https://github.com/carl-stone/openai-oauth), a
published fork of Evan Zhou's `openai-oauth`. The dependency ships its own
Apache-2.0 license and notice; this repository's required attribution is
included in [NOTICE](NOTICE).

The original gateway code in this repository is copyright Carl Stone and is
licensed under Apache-2.0. See [LICENSE](LICENSE).
