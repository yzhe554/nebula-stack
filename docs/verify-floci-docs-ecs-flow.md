# Verify Floci Docs ECS Flow

This verifies the local flow:

```text
API Gateway -> ALB -> ECS -> EC2 capacity -> docs container
```

For Floci, ECS runs the docs app as a Docker container, and the ALB target is the container IP/port.
The docs app uses port `3001`, matching `pnpm docs:dev`.

## 1. Start Floci

```bash
pnpm floci:up
```

Check Floci is reachable:

```bash
curl -i http://localhost:4566
```

## 2. Deploy Docs Flow

```bash
pnpm floci:deploy:docs
```

This command:

1. bootstraps the docs API Gateway if needed,
2. builds the Next.js app with the Floci API Gateway path prefix,
3. builds the Docker image,
4. deploys `docs-app,docs`,
5. restarts the ECS service so the new local image is used,
6. prints useful URLs.

The Docker image is:

```text
nebula-docs:local
```

Use `pnpm docs:docker:package` only for a generic local Docker image. For Floci, use `pnpm floci:deploy:docs` so static assets include `/execute-api/<api-id>/$default` automatically.

## 3. Verify ECS Service

```bash
AWS_ACCESS_KEY_ID=test \
AWS_SECRET_ACCESS_KEY=test \
AWS_SESSION_TOKEN= \
AWS_DEFAULT_REGION=us-east-1 \
NO_PROXY=localhost,127.0.0.1,.floci.localhost,.elb.localhost \
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
aws --endpoint-url=http://localhost:4566 ecs describe-services \
  --cluster dev-venture-core-public-docs-app \
  --services dev-venture-core-public-docs-app \
  --query 'services[0].{status:status,desired:desiredCount,running:runningCount,pending:pendingCount,loadBalancers:loadBalancers}' \
  --output json
```

Expected:

```json
{
  "status": "ACTIVE",
  "desired": 1,
  "running": 1,
  "pending": 0
}
```

Also confirm the load balancer container port is `3001`.

## 4. Verify ALB Target

```bash
TG_ARN=$(jq -r '.resources[] | select(.type=="aws_lb_target_group") | .instances[0].attributes.arn' infra/services/dev/venture/core/public/__generated__/floci/docs-app/terraform.tfstate)

AWS_ACCESS_KEY_ID=test \
AWS_SECRET_ACCESS_KEY=test \
AWS_SESSION_TOKEN= \
AWS_DEFAULT_REGION=us-east-1 \
NO_PROXY=localhost,127.0.0.1,.floci.localhost,.elb.localhost \
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
aws --endpoint-url=http://localhost:4566 elbv2 describe-target-health \
  --target-group-arn "$TG_ARN" \
  --query 'TargetHealthDescriptions[].{target:Target,state:TargetHealth.State,reason:TargetHealth.Reason}' \
  --output json
```

Expected target shape:

```json
[
  {
    "target": {
      "Id": "172.17.0.x",
      "Port": 3001
    }
  }
]
```

`state` may briefly be `initial`. The main pass condition is that the API Gateway URL returns `200 OK`.

## 5. Get API Gateway URL

```bash
pnpm floci:url
```

Open the `Docs via API Gateway` URL in your browser.

The output should include URLs like:

```text
Docs via API Gateway:
http://localhost:4566/execute-api/<api-id>/$default/docs

Docs via ALB (inside Floci container network; not directly host-accessible):
http://<docs-alb-dns>/docs
```

If only `docs-app,docs` are deployed, payment API URLs may show as not deployed. That is expected.

## 6. Verify API Gateway Response

```bash
API_ID=$(jq -r '.resources[] | select(.type=="aws_apigatewayv2_api") | .instances[0].attributes.id' infra/services/dev/venture/core/public/__generated__/floci/docs/terraform.tfstate)

NO_PROXY=localhost,127.0.0.1,.floci.localhost,.elb.localhost \
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
curl -i --max-time 20 "http://localhost:4566/execute-api/${API_ID}/\$default/docs"
```

Expected:

```text
HTTP/1.1 200 OK
```

If this returns `200 OK`, the full local flow works:

```text
API Gateway -> ALB -> ECS task -> docs container on port 3001
```

In a browser, the `Docs via API Gateway` URL should render with CSS and JavaScript. If it renders unstyled, rerun `pnpm floci:deploy:docs`.

## Optional: Inspect Docker Containers

```bash
docker ps --format 'table {{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Ports}}\t{{.Status}}'
```

You should see a Floci ECS container using image `nebula-docs:local`.

Floci does not publish the ECS task port to the host in Docker mode, so the ECS container direct URL and ALB URL are useful diagnostics from inside the Floci Docker network. The host-accessible URL is the `Docs via API Gateway` URL.

## Optional: Show Generated URLs

```bash
pnpm floci:url
```

This works for both docs-only deploys and full-stack deploys. Missing services are shown as `Not deployed` instead of failing the script.
