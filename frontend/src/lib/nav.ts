// Bottom navigation by server-assigned role. This only chooses which links to show; every page and
// API call is still authorized by the backend, so a hidden tab is never the protection.
export type NavRole = "employee" | "executive";

export interface NavTab {
  href: string;
  label: string;
  icon: "list" | "check" | "activity" | "user";
  /** Paths that highlight this tab. */
  match: (pathname: string) => boolean;
}

const starts = (...prefixes: string[]) => (p: string) => prefixes.some((x) => p === x || p.startsWith(`${x}/`));

export function tabsFor(role: NavRole): { tabs: NavTab[]; showCreate: boolean } {
  if (role === "executive") {
    return {
      showCreate: false,
      tabs: [
        { href: "/executive", label: "Approvals", icon: "check", match: starts("/executive") },
        { href: "/activity", label: "Activity", icon: "activity", match: starts("/activity", "/requests", "/purchases") },
        { href: "/account", label: "Account", icon: "user", match: starts("/account", "/settings") },
      ],
    };
  }
  return {
    showCreate: true,
    tabs: [
      { href: "/", label: "Requests", icon: "list", match: (p) => p === "/" || starts("/requests", "/purchases")(p) },
      { href: "/account", label: "Account", icon: "user", match: starts("/account", "/settings") },
    ],
  };
}
