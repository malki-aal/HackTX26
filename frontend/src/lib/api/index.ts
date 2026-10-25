import { fixtureApi } from "./fixtures";
import { liveApi } from "./live";
import type { RunwayApi } from "./client";

export const api: RunwayApi =
  process.env.NEXT_PUBLIC_API_MODE === "live" ? liveApi : fixtureApi;

export type { RunwayApi } from "./client";
export * from "./types";
