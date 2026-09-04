capture_data <- data.frame(
  sample = c("alpha", "beta", "gamma", "delta"),
  value = c(2, 4, 6, 8),
  group = factor(c("control", "control", "treated", "treated"))
)

capture_fit <- lm(value ~ group, data = capture_data)
capture_token <- "GOLDEN_R_SESSION_42"
