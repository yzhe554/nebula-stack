# Demo: Deploy `payment-api` To Floci

This demo deploys the sample DynamoDB table and Lambda to local Floci, invokes the Lambda, and verifies that the item was written to DynamoDB.

## Prerequisites

- Floci CLI is installed and available as `floci`.
- AWS CLI and Terraform are installed.
- Dependencies are installed with `pnpm install`.

Run the local setup once to create repo-local Terraform provider cache/mirror directories and CLI config:

```bash
pnpm setup:local
```

Platform deploy scripts load `.env.local` automatically, so Terraform provider downloads are reused across generated service folders and Terraform can install the cached AWS provider without repeatedly querying the registry.

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

This packages `apps/payment-api`, deploys `customer-records`, then deploys `payment-api` and the docs API Gateway to Floci.

## 3. Open The Local API Gateway

Start the docs app with the same base path Floci uses for the deployed HTTP API:

```bash
pnpm docs:dev:floci
```

Floci serves HTTP APIs through its path-style local execute endpoint. Get the generated API id:

```bash
pnpm floci:url
```

Then open:

```text
http://localhost:4566/execute-api/<api-id>/$default/
```

The root route proxies to `apps/docs`, and `POST /api/payments` invokes the Lambda route.

## 4. Invoke The Lambda

```bash
pnpm floci:invoke:payment-api customer-demo-1 approved-from-demo
```

Expected response:

```json
{"statusCode":200,"body":"{\"customerId\":\"customer-demo-1\",\"stored\":true}"}
```

## 5. Verify DynamoDB

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

This deletes the local Lambda, log group, IAM role/policies, and DynamoDB table, removes local generated Terraform state under each service folder's `__generated__/floci`, packages the Lambda, and redeploys all demo services including the docs API Gateway.

## Stop Floci

```bash
pnpm floci:down
```
