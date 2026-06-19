# Demo: Deploy `payment-api` To Floci And Write To DynamoDB

This demo runs the platform locally with Floci, deploys DynamoDB and Lambda, invokes the Lambda, and verifies the item was written to DynamoDB.

## 1. Start Floci

```bash
floci start
```

Check it is ready:

```bash
floci status
```

Optional: export local AWS CLI environment variables from Floci:

```bash
eval $(floci env)
```

If you do not run `eval $(floci env)`, prefix AWS CLI commands with the environment variables shown later in this guide.

## 2. Install Dependencies

```bash
pnpm install
```

## 3. Run Checks

```bash
pnpm typecheck
```

```bash
pnpm test
```

Validate all YAML config:

```bash
pnpm platform:validate
```

Or validate only the demo environment and venture:

```bash
pnpm platform:validate dev venture
```

## 4. Package The Lambda App

This uses Rolldown to bundle the ESM Lambda app into `dist/payment-api.zip`.

```bash
pnpm app:payment-api:package
```

Check the zip contents:

```bash
unzip -l dist/payment-api.zip
```

Expected files include:

```text
index.js
package.json
```

## 5. Deploy DynamoDB To Floci

```bash
pnpm platform:deploy -- --env dev --venture venture --target floci --services customer-records
```

This deploys:

```text
dev-venture-core-restricted-customer-records
```

## 6. Deploy Lambda To Floci

```bash
pnpm platform:deploy -- --env dev --venture venture --target floci --services payment-api
```

This deploys:

```text
dev-venture-core-internal-payment-api
```

Or deploy both services with one script:

```bash
pnpm floci:deploy:all
```

Check the table exists:

```bash
pnpm floci:list:tables
```

## 7. Invoke Lambda

Recommended script:

```bash
pnpm floci:invoke:payment-api customer-demo-1 approved-from-demo
```

The script sets fake Floci AWS credentials and clears local proxy variables for the command. It also tolerates a leading `--` if your shell/pnpm usage includes one.

Manual command:

```bash
AWS_ACCESS_KEY_ID=test \
AWS_SECRET_ACCESS_KEY=test \
AWS_DEFAULT_REGION=ap-southeast-2 \
AWS_EC2_METADATA_DISABLED=true \
NO_PROXY=localhost,127.0.0.1,localhost.floci.io,0.0.0.0 \
no_proxy=localhost,127.0.0.1,localhost.floci.io,0.0.0.0 \
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy \
aws --endpoint-url=http://localhost:4566 lambda invoke \
  --cli-binary-format raw-in-base64-out \
  --function-name dev-venture-core-internal-payment-api \
  --payload '{"body":"{\"customerId\":\"customer-demo-1\",\"message\":\"approved-from-demo\"}"}' \
  /tmp/payment-api-response.json
```

Show the Lambda response:

```bash
cat /tmp/payment-api-response.json
```

Expected response:

```json
{"statusCode":200,"body":"{\"customerId\":\"customer-demo-1\",\"stored\":true}"}
```

## 8. Verify DynamoDB Item

Recommended script:

```bash
pnpm floci:get:item customer-demo-1
```

Manual command:

```bash
AWS_ACCESS_KEY_ID=test \
AWS_SECRET_ACCESS_KEY=test \
AWS_DEFAULT_REGION=ap-southeast-2 \
AWS_EC2_METADATA_DISABLED=true \
NO_PROXY=localhost,127.0.0.1,localhost.floci.io,0.0.0.0 \
no_proxy=localhost,127.0.0.1,localhost.floci.io,0.0.0.0 \
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy \
aws --endpoint-url=http://localhost:4566 dynamodb get-item \
  --table-name dev-venture-core-restricted-customer-records \
  --key '{"customerId":{"S":"customer-demo-1"}}'
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

## 9. Optional: Inspect Generated Terraform

```bash
find generated/floci/dev/venture -name main.tf.json -print
```

```bash
sed -n '1,220p' generated/floci/dev/venture/payment-api/main.tf.json
```

```bash
sed -n '1,220p' generated/floci/dev/venture/customer-records/main.tf.json
```

## 10. Optional: Reset Local DynamoDB Table

Use this only for local Floci testing. Do not use this against real AWS data.

Disable deletion protection:

Recommended script:

```bash
pnpm floci:reset:ddb
```

This script disables local deletion protection, waits until Floci reports it disabled, deletes the table, and removes the generated local Terraform state for the table.

Or manually disable deletion protection:

```bash
AWS_ACCESS_KEY_ID=test \
AWS_SECRET_ACCESS_KEY=test \
AWS_DEFAULT_REGION=ap-southeast-2 \
aws --endpoint-url=http://localhost:4566 dynamodb update-table \
  --table-name dev-venture-core-restricted-customer-records \
  --no-deletion-protection-enabled
```

Delete the table:

```bash
AWS_ACCESS_KEY_ID=test \
AWS_SECRET_ACCESS_KEY=test \
AWS_DEFAULT_REGION=ap-southeast-2 \
aws --endpoint-url=http://localhost:4566 dynamodb delete-table \
  --table-name dev-venture-core-restricted-customer-records
```

Then redeploy:

```bash
rm -rf generated/floci/dev/venture/customer-records
pnpm platform:deploy -- --env dev --venture venture --target floci --services customer-records
```

## 11. Stop Floci

```bash
floci stop
```
