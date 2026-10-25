import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { Plus_Jakarta_Sans } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import { AppFrame } from "@/components/AppFrame";
import { AuthGate } from "@/components/auth";
import { IdentityProvider } from "@/lib/auth/identity";
import { clerkEnabled } from "@/lib/auth/config";

// One typeface everywhere: a geometric sans close to the reference's.
const jakarta = Plus_Jakarta_Sans({ variable: "--font-jakarta", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Runway",
  description: "Tools, materials and equipment for small engineering teams: options researched, people decide.",
  // Installed from the home screen, the app opens full screen with no browser bar.
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Runway" },
  icons: { icon: [{ url: "/icons/192", sizes: "192x192", type: "image/png" }], apple: [{ url: "/icons/180", sizes: "180x180", type: "image/png" }] },
  formatDetection: { telephone: false },
  other: { "mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#14532d",
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <IdentityProvider>
      <AppFrame>
        {/* The gate reads the pathname, which needs a Suspense boundary in a statically built app. */}
        <Suspense fallback={<div className="min-h-full bg-hero" />}>
          <AuthGate>{children}</AuthGate>
        </Suspense>
      </AppFrame>
    </IdentityProvider>
  );
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${jakarta.variable} antialiased`}>
      <body>
        {/* The provider exists only when a publishable key is configured; otherwise the app runs in explicit demo mode. */}
        {clerkEnabled ? (
          <ClerkProvider>
            <Shell>{children}</Shell>
          </ClerkProvider>
        ) : (
          <Shell>{children}</Shell>
        )}
      </body>
    </html>
  );
}
