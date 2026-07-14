import type { Metadata } from "next";
import { Geist, Geist_Mono, Inter, DM_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:3000");

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const interVariable = Inter({
  variable: "--font-inter-variable",
  subsets: ["latin"],
});

const dmMono = DM_Mono({
  variable: "--font-dm-mono",
  subsets: ["latin"],
  weight: ["300", "400", "500"],
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "EasyPeasyEase",
  description: "Stitch and apply ease curves to short videos.",
  icons: {
    icon: "/eze.svg",
  },
  openGraph: {
    title: "EasyPeasyEase",
    description: "Stitch and apply ease curves to short videos.",
    images: [
      {
        url: "/og-eze.jpg",
        width: 1200,
        height: 600,
        alt: "easy peasy ease wordmark on lime background",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "EasyPeasyEase",
    description: "Stitch and apply ease curves to short videos.",
    images: ["/og-eze.jpg"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${interVariable.variable} ${dmMono.variable} antialiased`}
      >
        {/* The site footer lives in app/page.tsx (landing view only), so the
            editors can use the full viewport height. */}
        <div className="min-h-screen flex flex-col">
          <main className="flex-1 flex flex-col">{children}</main>
        </div>
        <Analytics />
      </body>
    </html>
  );
}
