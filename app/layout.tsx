import type { Metadata } from "next";
import { Geist, Geist_Mono, Inter, DM_Mono } from "next/font/google";
import "./globals.css";

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
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${interVariable.variable} ${dmMono.variable} antialiased`}
      >
        <div className="min-h-screen flex flex-col">
          <main className="flex-1">{children}</main>
          <footer
            className="border-t border-border/50 px-6 py-4 text-[11px] text-muted-foreground tracking-wide"
            style={{ fontFamily: "var(--font-dm-mono)" }}
          >
            By Willie —{" "}
            <a
              href="https://github.com/shrimbly/easy-peasy-ease"
              className="underline hover:text-foreground transition-colors"
              target="_blank"
              rel="noreferrer"
            >
              code
            </a>{" "}
            —{" "}
            <a
              href="https://x.com/ReflctWillie"
              className="underline hover:text-foreground transition-colors"
              target="_blank"
              rel="noreferrer"
            >
              x
            </a>
          </footer>
        </div>
      </body>
    </html>
  );
}
