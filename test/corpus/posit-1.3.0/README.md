# Posit Assistant 1.3.0 request corpus

These are sanitized request bodies emitted by Posit Assistant in RStudio. They
were captured on the inbound side of the gateway, before
`adaptResponsesBody()` changed them.

Neither request headers nor response bodies are part of the corpus.

`manifest.json` records the capture environment, scenarios, expected wire
features, asset hashes, and every sanitization rule. Its RStudio version and
RStudio–Assistant protocol are provenance, not gateway compatibility claims;
the captured `/responses` bodies are the relevant wire evidence. `project/` is
the synthetic RStudio project used for the run. `requests/` contains only
sanitized JSON; raw captures must never be committed. See
[`dev/README.md`](../../../dev/README.md) for the interface boundaries.

## Reproduce a capture

Raw requests contain prompts, paths, tool arguments, file contents, and model
reasoning. Use only synthetic data, keep the proxy on loopback, inspect the raw
files locally, and delete them after sanitization.

A live run sends model requests through the configured gateway, and RStudio may
also query installed provider catalogs during startup. Confirm the allowed
provider and budget before reproducing it.

From the repository root:

```sh
npm run build
capture_dir=/tmp/posit-golden-capture
mkdir -p "$capture_dir/raw" "$capture_dir/runtime"
printf '%s\n' setup >"$capture_dir/scenario"

R_ASSISTANT_GATEWAY_INTERNAL_RUNTIME_DIR="$capture_dir/runtime" \
  node dist/cli.js --detach --host 127.0.0.1 --port 10532 \
  --models gpt-5.6-luna --responses-state memory

POSIT_CAPTURE_TARGET=http://127.0.0.1:10532 \
POSIT_CAPTURE_PORT=10533 \
POSIT_CAPTURE_OUTPUT_DIR="$capture_dir/raw" \
POSIT_CAPTURE_LABEL_FILE="$capture_dir/scenario" \
  npx tsx scripts/capture-posit-requests.ts
```

In another shell, launch `project/posit-golden-capture.Rproj` with process-local
provider settings:

```sh
OPENAI_BASE_URL=http://127.0.0.1:10533/v1 \
OPENAI_API_KEY=local-gateway \
PA_PROVIDER=openai \
PA_MODEL=gpt-5.6-luna \
  rstudio test/corpus/posit-1.3.0/project/posit-golden-capture.Rproj
```

Before each scenario, write a short label to `$capture_dir/scenario`. The proxy
uses it in the next sequential filename. It records POST `/responses` bodies
only, not headers, and creates raw files with mode `0600`.

Sanitize a reviewed run into a separate directory:

```sh
npx tsx scripts/sanitize-posit-corpus.ts \
  "$capture_dir/raw" test/corpus/posit-1.3.0/requests \
  --media-root test/corpus/posit-1.3.0/project \
  --exclude 0010-07-file-mention-context.json
```

The exclusion above is specific to the original run and is documented in the
manifest. A new run should exclude only requests independently confirmed to be
unrepresentative. Review the output again before committing it.

The sanitizer fails unless every embedded data URL exactly matches one of the
synthetic PNG/PDF assets in `--media-root`. It validates the complete output
before atomically replacing a directory carrying its marker file.

It also accepts only the versioned developer-prompt fingerprints recorded in
the manifest (after date-line normalization). This is intentionally fail-closed:
prompt drift requires review and an explicit fingerprint update. The sanitizer
holds an exclusive lock, moves an existing output aside, and verifies its
marker inventory and hashes both before replacement and before removal. Do not
modify the output concurrently while sanitization is running.

When finished, close RStudio, stop the capture proxy, stop the detached gateway
with the same `R_ASSISTANT_GATEWAY_INTERNAL_RUNTIME_DIR`, and remove the raw
capture directory.
