# Demo: Deploy `payment-api` To Floci

This demo deploys the sample DynamoDB table and Lambda to local Floci, invokes the Lambda, and verifies that the item was written to DynamoDB.

## Prerequisites

- Floci CLI is installed and available as `floci`.
- AWS CLI and Terraform are installed.
- Dependencies are installed with `pnpm install`.

## 1. Start Floci

```bash
pnpm floci:up
```

Optional health check:

```bash
floci status
```

## 2. Deploy Everything

```bash
pnpm floci:deploy:all
```

This packages `apps/payment-api`, deploys `customer-records`, then deploys `payment-api` to Floci.

## 3. Invoke The Lambda

```bash
pnpm floci:invoke:payment-api customer-demo-1 approved-from-demo
```

Expected response:

```json
{"statusCode":200,"body":"{\"customerId\":\"customer-demo-1\",\"stored\":true}"}
```

## 4. Verify DynamoDB

```bash
pnpm floci:get:item customer-demo-1
```

Expected output includes:

```json
{
  "Item": {
    "customerId": {
      "S": "customer-demo-1"
    },
    "message": {
      "S": "approved-from-demo"
    }
  }
}
```

## Reset And Redeploy

Use this when you want a clean local Floci demo state.

To reset/cleanup everything without redeploying:

```bash
pnpm floci:reset:all
```

To reset/cleanup and redeploy everything:

```bash
pnpm floci:redeploy:all
```

This destroys the local Lambda stack if present, deletes the local DynamoDB table after disabling deletion protection, removes local generated Terraform state under `__generated__/floci/dev/venture`, packages the Lambda, and redeploys both services.

## Stop Floci

```bash
pnpm floci:down
```
