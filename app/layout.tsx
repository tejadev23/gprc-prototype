import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GPRC",
  description: "Geographically placed roadway corridor prototype.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full dark">
      <body className="min-h-full antialiased">{children}</body>
    </html>
  );
}
