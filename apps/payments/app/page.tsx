import { PaymentsForm } from "./payments-form";

export const dynamic = "force-dynamic";

export default function PaymentsPage() {
  const paymentApiBaseUrl = process.env.PAYMENT_API_BASE_URL ?? "";
  return <PaymentsForm paymentApiBaseUrl={paymentApiBaseUrl} />;
}
