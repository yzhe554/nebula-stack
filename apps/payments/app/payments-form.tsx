"use client";

import { FormEvent, useMemo, useState } from "react";

type SubmitState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; response: unknown }
  | { status: "error"; message: string };

const defaultPaymentApiBaseUrl = "http://localhost:4566/execute-api/<payment-api-id>/$default";

export function PaymentsForm({ paymentApiBaseUrl: rawBaseUrl }: { paymentApiBaseUrl: string }) {
  const [customerId, setCustomerId] = useState("customer-local-1");
  const [message, setMessage] = useState("created from payments app");
  const [state, setState] = useState<SubmitState>({ status: "idle" });

  const paymentApiBaseUrl = useMemo(() => trimTrailingSlash(rawBaseUrl ?? ""), [rawBaseUrl]);
  const isConfigured = paymentApiBaseUrl.length > 0;

  async function submitPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!isConfigured) {
      setState({
        status: "error",
        message: "Set PAYMENT_API_BASE_URL before submitting payments.",
      });
      return;
    }

    setState({ status: "loading" });

    try {
      const response = await fetch(`${paymentApiBaseUrl}/api/payments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerId, message }),
      });
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(`Payment API returned ${response.status}: ${JSON.stringify(body)}`);
      }

      setState({ status: "success", response: body });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Internal payments</p>
        <h1>Submit a payment API request</h1>
        <p className="lede">
          This temporary unauthenticated UI calls the internal payment API. Cognito login and token
          forwarding will be added in the separate auth plan.
        </p>
      </section>

      <section className="panel">
        <form onSubmit={submitPayment} className="form">
          <label>
            <span>Customer ID</span>
            <input value={customerId} onChange={(event) => setCustomerId(event.target.value)} />
          </label>
          <label>
            <span>Message</span>
            <textarea value={message} onChange={(event) => setMessage(event.target.value)} />
          </label>
          <button type="submit" disabled={state.status === "loading"}>
            {state.status === "loading" ? "Submitting..." : "Submit payment"}
          </button>
        </form>

        <div className="result" aria-live="polite">
          <h2>Result</h2>
          {!isConfigured ? (
            <p className="warning">
              Configure <code>PAYMENT_API_BASE_URL</code>. For Floci this looks like{" "}
              <code>{defaultPaymentApiBaseUrl}</code>.
            </p>
          ) : null}
          {state.status === "idle" ? <p>Submit the form to see the Lambda response.</p> : null}
          {state.status === "loading" ? <p>Calling payment API...</p> : null}
          {state.status === "error" ? <p className="error">{state.message}</p> : null}
          {state.status === "success" ? (
            <pre>
              <code>{JSON.stringify(state.response, null, 2)}</code>
            </pre>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
