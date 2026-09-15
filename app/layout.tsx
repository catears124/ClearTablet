import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "tablet.ears.cat",
  description: "firmware patching and configuration for drawing tablets",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
