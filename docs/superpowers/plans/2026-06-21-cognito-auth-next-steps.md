# Cognito Auth Plan

## Goal

Add Cognito login support and configure API Gateway so only authenticated users can access the payments app and payment API routes.

## Run Order

Run this plan second, after `docs/superpowers/plans/2026-06-21-payments-app-next-steps.md`. It depends on the payments app and routes existing first.

## Current Direction

- Cognito/auth is separate from the payments UI implementation.
- The platform should support a Cognito service type.
- The platform should support API Gateway authorizers.
- Demo users should be available for local/dev testing if practical.

## Step 1: Add Cognito Platform Service Type

Add a new platform service type:

- `cognito`

Likely files:

- `packages/platform/schemas/cognito.schema.ts`
- `packages/platform/schemas/cognito.schema.json`
- `packages/platform/src/types.ts`
- `packages/platform/src/schema-json.ts`
- `packages/platform/src/schemas.ts`
- `packages/platform/src/service-discovery.ts`
- `packages/platform/src/terraform.ts`

Expected Terraform resources:

- `aws_cognito_user_pool`
- `aws_cognito_user_pool_client`
- optional user/group resources if we seed users with Terraform

## Step 2: Add Cognito Service Config

Add a Cognito service YAML file.

Likely file:

- `infra/services/dev/venture/core/internal/login.cognito.yaml`

Example shape:

```yaml
userPool:
  selfSignUpEnabled: false
  signInAliases:
    - email
client:
  callbackUrls:
    - http://localhost:3002/payments/callback
  logoutUrls:
    - http://localhost:3002/payments
seedUsers:
  - username: demo@example.com
    temporaryPassword: Password123!
```

## Step 3: Decide How To Seed Demo Users

Preferred options:

1. Terraform-managed Cognito users for dev only.
2. Post-deploy script that creates/updates demo users.
3. No seeded users; document manual user creation.

Initial preference:

- Use a post-deploy/local helper script if Terraform support is awkward or Floci compatibility is limited.
- Keep seeded users dev-only.

Likely script:

- `packages/platform/scripts/floci-cognito-seed-users.sh`

## Step 4: Add API Gateway Authorizer Support

Extend API Gateway route config so routes can require Cognito auth.

Likely schema change in:

- `packages/platform/schemas/apigateway.schema.ts`

Example route shape:

```yaml
routes:
  - path: /payments
    method: ANY
    auth:
      type: cognito
      service: login
    target:
      type: http_proxy
      uri: http://host.docker.internal:3002/payments
```

Terraform should generate:

- `aws_apigatewayv2_authorizer`
- route `authorization_type: JWT`
- route `authorizer_id`

## Step 5: Protect Payments Routes

Apply Cognito auth to payments app routes and payment API routes.

Likely service files:

- `infra/services/dev/venture/core/internal/payments.apigateway.yaml`
- `infra/services/dev/venture/core/internal/payment-api-ingress.apigateway.yaml`

Routes to protect:

- `ANY /payments`
- `ANY /payments/{proxy+}`
- `POST /api/payments`

Do not protect public docs routes.

## Step 6: Add Login Flow To Payments App

Add login behavior to the `payments` app after the Cognito service exists.

Initial simple UI:

- Login form with username/password.
- Store token for local testing.
- Include token when calling the payment API.
- Show logged-in user and logout button.

Expected request header:

```ts
authorization: `Bearer ${token}`
```

## Step 7: Update Local Scripts And Docs

Update scripts/docs so developers can find Cognito details and test auth locally.

Likely files:

- `scripts/floci-url.sh`
- `packages/platform/scripts/floci-reset-all.sh`
- `infra/services/docs/demo-floci-payment-api.md`

Expected helper output:

- Cognito user pool id.
- Cognito user pool client id.
- Demo username.
- Payments app URL.

## Step 8: Tests And Verification

Add or update tests for:

- Cognito schema JSON generation.
- Cognito service discovery.
- Cognito Terraform generation.
- API Gateway authorizer Terraform generation.
- Validation errors for routes referencing unknown Cognito services.
- Payments app auth/token behavior.

Useful commands:

```bash
pnpm --filter @repo/platform test
pnpm --filter @repo/platform run validate dev venture
pnpm platform:generate -- --env dev --venture venture --target floci
pnpm --filter @repo/payments typecheck
pnpm typecheck
```

## Open Questions

- Does Floci support Cognito user pools and API Gateway JWT authorizers well enough for local end-to-end testing?
- Should login use Cognito hosted UI or a custom username/password form?
- Should demo users be managed by Terraform or a local seed script?
- Should auth protect the payments UI gateway, the payment API gateway, or both? Initial preference: both.

## Suggested First Milestone

1. Add Cognito schema and Terraform generation.
2. Add `login.cognito.yaml`.
3. Generate Cognito user pool/client.
4. Add API Gateway Cognito authorizer support.
5. Protect payment API route first.
6. Add payments app login/token flow.
7. Protect payments UI routes.
