export const FLOCI_ENDPOINT = "http://localhost:4566";

const PROXY_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
];

export function scrubbedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of PROXY_KEYS) delete env[key];
  env.AWS_ACCESS_KEY_ID = "test";
  env.AWS_SECRET_ACCESS_KEY = "test";
  env.AWS_DEFAULT_REGION = "us-east-1";
  env.AWS_REGION = "us-east-1";
  env.AWS_EC2_METADATA_DISABLED = "true";
  env.NO_PROXY = "localhost,127.0.0.1,localhost.floci.io,.floci.localhost,.elb.localhost,0.0.0.0";
  env.no_proxy = env.NO_PROXY;
  delete env.AWS_SESSION_TOKEN;
  return env;
}

export function flociClientConfig() {
  return {
    endpoint: FLOCI_ENDPOINT,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  };
}
