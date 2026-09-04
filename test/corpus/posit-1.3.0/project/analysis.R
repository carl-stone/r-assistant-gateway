source("setup.R")

capture_mean <- mean(capture_data$value)
capture_summary <- summary(capture_fit)

plot(
  capture_data$value,
  type = "b",
  col = "#3366CC",
  main = "Synthetic Golden Capture",
  xlab = "Observation",
  ylab = "Value"
)
