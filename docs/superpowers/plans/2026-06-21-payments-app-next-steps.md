# Payments App Plan

## Goal

Add a new `payments` Next.js app that provides a UI for invoking the internal `payment-api` Lambda route.

## Run Order

Run this plan first. It creates the payments UI and unauthenticated wiring that the Cognito/auth plan will protect later.

## Current Direction

- `docs` remains the public documentation app.
- `payment-api` remains the internal Lambda API.
- `payments` becomes a separate UI app for payment operations.
- Authentication will be handled in a separate Cognito/auth plan.

## Step 1: Create Payments Next.js App

Create a new app at:

- `apps/payments`

Expected app responsibilities:

- Render a simple payment form.
- Let the user enter `customerId` and `message`.
- Submit the form to the payment API.
- Show the Lambda response or an error message.

Likely files:

- `apps/payments/package.json`
- `apps/payments/tsconfig.json`
- `apps/payments/next.config.ts`
- `apps/payments/app/layout.tsx`
- `apps/payments/app/page.tsx`
- `apps/payments/app/globals.css`

## Step 2: Add Workspace Scripts

Update root scripts so the app is easy to run.

Likely changes in `package.json`:

- Add `payments:dev`.
- Add `payments:build` if needed.
- Ensure `pnpm typecheck` covers `@repo/payments` through Turborepo.

Example scripts:

```json
{
  "payments:dev": "pnpm --filter @repo/payments run dev",
  "payments:build": "pnpm --filter @repo/payments run build"
}
```

## Step 3: Configure Payments App Base Path

Use a base path so the app can run behind Floci API Gateway path-style URLs.

Likely route:

- `/payments`

Likely config file:

- `apps/payments/next.config.ts`

Use the existing docs app pattern from:

- `apps/docs/next.config.ts`

## Step 4: Add Payments App Ingress

Add an API Gateway service for the payments UI app.

Likely service file:

- `infra/services/dev/venture/core/internal/payments.apigateway.yaml`

Expected routes:

- `ANY /payments`
- `ANY /payments/{proxy+}`

Expected target:

- HTTP proxy to the local Next.js payments app, likely `http://host.docker.internal:3002/payments`.

Keep this separate from `docs.apigateway.yaml` because `docs` is public and `payments` will be protected later.

## Step 5: Wire UI To Payment API

The payments app should call the internal payment API Gateway endpoint.

Use an environment variable for the API base URL:

- `NEXT_PUBLIC_PAYMENT_API_BASE_URL`

Expected request shape:

```ts
await fetch(`${paymentApiBaseUrl}/api/payments`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
  },
  body: JSON.stringify({ customerId, message }),
});
```

Authentication headers will be added later by the Cognito/auth plan.

## Step 6: Update Local Scripts

Update helper scripts so local dev can discover and run the payments app.

Likely files:

- `scripts/floci-url.sh`
- New script: `scripts/payments-dev-floci.sh`
- `package.json`

Expected `pnpm floci:url` output:

- Docs URL.
- Payments app URL.
- Payment API URL.

## Step 7: Tests And Verification

Add or update tests/checks for:

- Payments app typecheck.
- Payments app build.
- Platform Terraform generation for payments app ingress.
- Existing payment API Lambda tests.

Useful commands:

```bash
pnpm --filter @repo/payments typecheck
pnpm --filter @repo/payments run build
pnpm --filter @repo/platform test
pnpm --filter @repo/platform run validate dev venture
pnpm platform:generate -- --env dev --venture venture --target floci
pnpm typecheck
```

## Open Questions

- Should the payments app run on port `3002` locally?
- Should the payments app gateway be internal-only with no custom domain or Route53?
- Should the UI call payment API directly from the browser, or through a Next.js server action/API route?

## Suggested First Milestone

1. Create `apps/payments` with a static form.
2. Add local dev script on port `3002`.
3. Add internal API Gateway proxy for `/payments`.
4. Wire the form to `NEXT_PUBLIC_PAYMENT_API_BASE_URL`.
5. Verify the form can invoke `payment-api` before adding auth.
