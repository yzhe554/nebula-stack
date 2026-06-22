import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";

export async function POST(request: Request) {
  const functionName = process.env.PAYMENT_API_FUNCTION_NAME;

  if (!functionName) {
    return Response.json({ error: "PAYMENT_API_FUNCTION_NAME is not configured" }, { status: 500 });
  }

  const payload = await request.text();

  const client = new LambdaClient({
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
    endpoint: process.env.AWS_ENDPOINT_URL,
    credentials: process.env.AWS_ENDPOINT_URL
      ? { accessKeyId: "test", secretAccessKey: "test" }
      : undefined,
  });

  const result = await client.send(
    new InvokeCommand({
      FunctionName: functionName,
      Payload: Buffer.from(payload || "{}"),
    }),
  );

  const body = result.Payload ? Buffer.from(result.Payload).toString("utf8") : "{}";

  return new Response(body, {
    status: result.FunctionError ? 502 : 200,
    headers: { "content-type": "application/json" },
  });
}
