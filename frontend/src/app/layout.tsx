import type { Metadata, Viewport } from "next";
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
  description: "Purchasing requests, researched and reviewed.",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Runway" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#4f46e5",
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <IdentityProvider>
      <AppFrame>
        <AuthGate>{children}</AuthGate>
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
