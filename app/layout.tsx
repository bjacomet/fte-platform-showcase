import type { Metadata } from "next";
import { Montserrat, Dancing_Script } from "next/font/google";
import "./globals.css";

const montserrat = Montserrat({
  subsets: ["latin"],
  variable: "--font-montserrat",
  display: "swap",
});

const dancingScript = Dancing_Script({
  subsets: ["latin"],
  variable: "--font-dancing",
  display: "swap",
});

export const metadata: Metadata = {
  title: "FTE Platform",
  description: "Follow The Eyes — Creative Project Management",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`h-full antialiased ${montserrat.variable} ${dancingScript.variable}`}>
      <body className="min-h-full bg-[#0f1117] text-gray-100 font-[family-name:var(--font-montserrat)]">{children}</body>
    </html>
  );
}
