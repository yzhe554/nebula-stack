export default {
  input: "index.ts",
  platform: "node",
  output: {
    file: "dist/payment-api-package/index.js",
    format: "esm",
    codeSplitting: false,
  },
};
