# Service YAML Schemas

These JSON Schema files describe the YAML shape supported by the platform.

YAML files are intentionally explicit: platform-owned fields must be configured in YAML instead of relying on hidden defaults.

- `lambda.schema.json` supports `*.lambda.yaml` service files.
- `dynamodb.schema.json` supports `*.dynamodb.yaml` service files.
- `network.schema.json` supports `services/<env>/<venture>/<vpc>/network.yaml` files.

Service files live under:

```text
services/<env>/<venture>/<vpc>/<security-zone>/<service-name>.<service-type>.yaml
```

The folder path provides `env`, `venture`, `vpc`, `securityZone`, `serviceName`, and `serviceType`. Do not repeat those fields in the YAML body.

Editors can use the YAML Language Server schema comment for autocomplete, for example:

```yaml
# yaml-language-server: $schema=../../../../../schemas/lambda.schema.json
runtime: nodejs22.x
handler: index.handler
package: ../../dist/payment-api.zip
```

IPv4 network policy example:

```yaml
# yaml-language-server: $schema=../../../../schemas/network.schema.json
cidrs:
  ipv4:
    vpc: 10.20.0.0/16

zones:
  internal:
    description: Application services that are not public.
    subnets:
      - 10.20.10.0/24

flows:
  - from: internal
    to: restricted
    ports: [443]
  - from: internal
    to: aws
    services: [dynamodb, logs]

awsEndpoints:
  dynamodb:
    type: gateway
    serviceName: com.amazonaws.ap-southeast-2.dynamodb
    routeTableZoneNames: [internal]
    policy: default
```
