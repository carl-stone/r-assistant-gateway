# Synthetic capture project

This project contains only deterministic, non-sensitive data used to capture the
request shapes emitted by Posit Assistant in RStudio.

- `setup.R` creates a small data frame, model, and sentinel token.
- `analysis.R` reads those objects and draws a simple plot.
- `data/synthetic.csv` is safe file context.
- `synthetic-plot.png` and `synthetic-report.pdf` are attachment fixtures.

Run `generate-assets.R` from this directory to regenerate the attachment
inputs. Their capture-time SHA-256 hashes are recorded in `../manifest.json`.
