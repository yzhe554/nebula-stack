export default {
  input: "apps/payment-api/index.mjs",
  platform: "node",
  output: {
    file: "dist/payment-api-package/index.js",
    format: "esm",
    codeSplitting: false,
  },
};
