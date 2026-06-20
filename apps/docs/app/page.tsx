const sections = [
  { id: "overview", label: "Overview" },
  { id: "workspace", label: "Workspace" },
  { id: "apps", label: "Apps" },
  { id: "platform", label: "Platform" },
  { id: "infra", label: "Infra" },
  { id: "local", label: "Local workflow" },
];

const repoAreas = [
  {
    name: "apps/payment-api",
    eyebrow: "Lambda application",
    description:
      "Owns the sample payment API handler, app-local tests, and packaged Lambda artifact under apps/payment-api/dist.",
    links: ["index.ts", "tests/handler.test.ts", "dist/payment-api.zip"],
  },
  {
    name: "apps/docs",
    eyebrow: "Documentation app",
    description: "A Next.js app that documents the repository architecture and developer workflow.",
    links: ["app/page.tsx", "app/layout.tsx", "app/globals.css"],
  },
  {
    name: "packages/platform",
    eyebrow: "Infrastructure platform",
    description:
      "TypeScript CLIs, Zod schemas, Terraform JSON generation, deployment orchestration, validation, and platform tests.",
    links: ["src/generate.ts", "src/deploy.ts", "schemas/*.schema.ts"],
  },
  {
    name: "infra/services",
    eyebrow: "Service intent",
    description:
      "Environment and venture YAML definitions. Generated Terraform sits next to the service that owns it.",
    links: ["dev/venture/core", "docs/demo-floci-payment-api.md", "**/__generated__"],
  },
];

const commands = [
  ["Set up local cache", "pnpm setup:local"],
  ["Run docs locally", "pnpm docs:dev"],
  ["Run docs behind Floci", "pnpm docs:dev:floci"],
  ["Reset docs cache", "pnpm docs:reset"],
  ["Run all tests", "pnpm test"],
  ["Typecheck packages", "pnpm typecheck"],
  ["Deploy to Floci", "pnpm floci:deploy:all"],
  ["Print Floci URLs", "pnpm floci:url"],
  ["Reset Floci state", "pnpm floci:reset:all"],
  ["Reset and redeploy", "pnpm floci:redeploy:all"],
];

const apiGatewayUrl = "http://localhost:4566/execute-api/<api-id>/$default/docs";

export default function Home() {
  return (
    <main className="shell">
      <aside className="sidebar" aria-label="Documentation navigation">
        <div className="brand">
          <span className="brandMark">◆</span>
          <span>NebulaStack</span>
        </div>
        <nav>
          {sections.map((section) => (
            <a key={section.id} href={`#${section.id}`}>
              {section.label}
            </a>
          ))}
        </nav>
      </aside>

      <article className="content">
        <section id="overview" className="hero">
          <p className="eyebrow">Architecture</p>
          <h1>NebulaStack architecture</h1>
          <p className="lede">
            A full-stack Turborepo workspace for frontend docs, backend services, managed data, and
            infrastructure-as-code.
          </p>
          <div className="heroActions">
            <a className="primaryAction" href="#workspace">
              Explore workspace
            </a>
            <a className="secondaryAction" href="#local">
              Run locally
            </a>
          </div>
        </section>

        <section id="workspace" className="sectionBlock">
          <div className="sectionHeader">
            <p className="eyebrow">Workspace model</p>
            <h2>Root orchestration, package ownership</h2>
          </div>
          <p>
            The repository root owns Turborepo tasks and convenience scripts. Each workspace package
            owns its code, tests, and build outputs. Infrastructure YAML lives under{" "}
            <code>infra/services</code> so generated Terraform can stay near the service definition
            that produced it.
          </p>
          <pre className="tree">
            <code>{`.
├── apps/
│   ├── docs/           # Next.js architecture docs
│   └── payment-api/    # Lambda app and app-local dist
├── packages/
│   └── platform/       # TypeScript infra platform
├── infra/
│   └── services/       # YAML service intent and generated Terraform
├── pnpm-workspace.yaml
└── turbo.json`}</code>
          </pre>
        </section>

        <section id="apps" className="sectionBlock">
          <div className="sectionHeader">
            <p className="eyebrow">Repo areas</p>
            <h2>What each folder owns</h2>
          </div>
          <div className="cardGrid">
            {repoAreas.map((area) => (
              <div className="card" key={area.name}>
                <p className="cardEyebrow">{area.eyebrow}</p>
                <h3>{area.name}</h3>
                <p>{area.description}</p>
                <ul>
                  {area.links.map((link) => (
                    <li key={link}>
                      <code>{link}</code>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        <section id="platform" className="sectionBlock split">
          <div>
            <p className="eyebrow">Platform flow</p>
            <h2>YAML to Terraform</h2>
            <p>
              Platform commands discover service YAML, validate with Zod schemas, derive physical
              AWS names from path metadata, and write Terraform JSON beside the owning service
              folder.
            </p>
          </div>
          <pre>
            <code>{`infra/services/dev/venture/core/
├── internal/payment-api.lambda.yaml
├── public/docs.apigateway.yaml
└── managed/customer-records.dynamodb.yaml`}</code>
          </pre>
        </section>

        <section id="infra" className="sectionBlock">
          <div className="callout">
            <p className="eyebrow">Generated files</p>
            <h2>Generated Terraform is colocated</h2>
            <p>
              Each service gets its own Terraform module under <code>__generated__</code>. That
              keeps local Terraform state and generated JSON close to the YAML source while
              remaining ignored by Git.
            </p>
          </div>
        </section>

        <section id="local" className="sectionBlock">
          <div className="sectionHeader">
            <p className="eyebrow">Local workflow</p>
            <h2>Common commands</h2>
          </div>
          <div className="commandList">
            {commands.map(([label, command]) => (
              <div className="command" key={command}>
                <span>{label}</span>
                <code>{command}</code>
              </div>
            ))}
          </div>
          <div className="callout">
            <p className="eyebrow">Floci API Gateway</p>
            <h2>Local ingress uses Floci path-style URLs</h2>
            <p>
              After <code>pnpm floci:deploy:all</code>, get the HTTP API id from Floci and open
              <code>{apiGatewayUrl}</code>. The `/docs` route proxies to this docs app and
              <code>/api/payments</code> invokes the Lambda route.
            </p>
          </div>
        </section>
      </article>
    </main>
  );
}
