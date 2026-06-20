export default {
  input: "index.mjs",
  platform: "node",
  output: {
    file: "dist/payment-api-package/index.js",
    format: "esm",
    codeSplitting: false,
  },
};
