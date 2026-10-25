import type { z } from "zod";
import type { Condition as ConditionSchema, AllowedCondition as AllowedConditionSchema } from "../contracts/domain.js";

export type Condition = z.infer<typeof ConditionSchema>;
export type AllowedCondition = z.infer<typeof AllowedConditionSchema>;
export type {
  Requirement,
  RequirementAttribute,
  RequestFields,
  Offer,
  SpecEvidence,
  RequirementResult,
  PurchaseCost,
  CandidateEvaluation,
  FinancialContext,
  BudgetAssessment,
  AgentConfig,
} from "../contracts/domain.js";

/** Minimal validated shape of a SerpApi google_shopping result item we rely on. */
export interface RawShoppingItem {
  position?: number;
  title: string;
  product_id?: string;
  product_link?: string;
  link?: string;
  source?: string;
  price?: string;
  extracted_price?: number;
  old_price?: string;
  installment?: unknown;
  alternative_price?: unknown;
  second_hand_condition?: string;
  delivery?: string;
  snippet?: string;
  extensions?: string[];
  tag?: string;
  thumbnail?: string;
  rating?: number;
  reviews?: number;
  /** Opaque SerpApi token for the product-detail page; kept server-side only. */
  immersive_product_page_token?: string;
}

/** Validated subset of a SerpApi google_immersive_product response (domain-level type). */
export interface ProductDetails {
  title: string | null;
  features: Array<{ title: string; value: string }>;
  stores: Array<{ name: string; extractedPrice: number | null; shipping: string | null; shippingExtracted: number | null; details: string[] }>;
}
