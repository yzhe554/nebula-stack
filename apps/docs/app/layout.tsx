import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Repo Architecture",
  description: "Architecture notes for the local infrastructure demo repo.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
