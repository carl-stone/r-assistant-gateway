png("synthetic-plot.png", width = 480, height = 320, bg = "white")
plot(
  c(2, 4, 6, 8),
  type = "b",
  pch = 19,
  col = "#3366CC",
  main = "GOLDEN_IMAGE_17",
  xlab = "Observation",
  ylab = "Value"
)
dev.off()

pdf_stream <- paste0(
  "BT\n",
  "/F1 18 Tf\n72 210 Td\n(Synthetic Golden Report) Tj\n",
  "/F1 13 Tf\n0 -42 Td\n(Document token: GOLDEN_PDF_23) Tj\n",
  "0 -30 Td\n(Values: 2, 4, 6, 8) Tj\n",
  "ET\n"
)
pdf_objects <- c(
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  paste0(
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 432 288] ",
    "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"
  ),
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  paste0("<< /Length ", nchar(pdf_stream, type = "bytes"), " >>\nstream\n", pdf_stream, "endstream")
)
pdf_header <- "%PDF-1.4\n"
pdf_body <- ""
pdf_offsets <- integer(length(pdf_objects))
for (index in seq_along(pdf_objects)) {
  pdf_offsets[index] <- nchar(pdf_header, type = "bytes") + nchar(pdf_body, type = "bytes")
  pdf_body <- paste0(pdf_body, index, " 0 obj\n", pdf_objects[index], "\nendobj\n")
}
xref_offset <- nchar(pdf_header, type = "bytes") + nchar(pdf_body, type = "bytes")
pdf_xref <- paste0(
  "xref\n0 ", length(pdf_objects) + 1L, "\n",
  "0000000000 65535 f \n",
  paste0(sprintf("%010d 00000 n \n", pdf_offsets), collapse = ""),
  "trailer\n<< /Size ", length(pdf_objects) + 1L, " /Root 1 0 R >>\n",
  "startxref\n", xref_offset, "\n%%EOF\n"
)
writeBin(
  charToRaw(paste0(pdf_header, pdf_body, pdf_xref)),
  "synthetic-report.pdf"
)
