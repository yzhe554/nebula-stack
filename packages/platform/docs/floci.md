# Floci Local AWS Emulator

Use Floci to generate and deploy Terraform without a real AWS account.

## Start Floci

```bash
pnpm floci:up
```

Floci listens on:

```text
http://localhost:4566
```

The npm scripts use the installed Floci CLI: `floci start` and `floci stop`.

## Generate Local Terraform

```bash
pnpm platform:generate -- --env dev --venture venture --target floci
```

Generated Terraform is written under:

```text
__generated__/floci/dev/venture/<service-name>/main.tf.json
```

This keeps local emulator state separate from real AWS state under `__generated__/aws/...`.

## Deploy To Floci

Deploy all `dev/venture` services:

```bash
pnpm floci:deploy
```

Deploy selected services:

```bash
pnpm platform:deploy -- --env dev --venture venture --target floci --services customer-records
```

## Stop Floci

```bash
pnpm floci:down
```

## Notes

The generated AWS provider uses fake credentials and points supported service endpoints at `http://localhost:4566` when `--target floci` is selected.
