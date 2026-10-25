import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { AppFrame } from "@/components/AppFrame";

// Fallback only; Apple devices render the native system font first.
const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Runway",
  description: "Purchasing requests, researched and reviewed.",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Runway" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} antialiased`}>
      <body>
        <AppFrame>{children}</AppFrame>
      </body>
    </html>
  );
}
