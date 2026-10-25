import { AuthGate } from "@/components/auth";

// Approval screens need the executive role in signed-in mode. The backend must enforce this too.
export default function ExecutiveLayout({ children }: { children: React.ReactNode }) {
  return <AuthGate need="executive">{children}</AuthGate>;
}
