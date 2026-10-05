import { z } from "zod";
import {
  canonicalOAuthContractSchema,
  authStatusContractSchema,
  tokenWizardContractSchema,
} from "./contracts.schema";

export const oauthEntrySchema = canonicalOAuthContractSchema;
export const authStatusSchema = authStatusContractSchema;
export const tokenWizardInputSchema = tokenWizardContractSchema;

export const nativeCodexTokensSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  id_token: z.string().min(1).optional(),
  expires_in: z.number().finite().positive().optional(),
  account_id: z.string().nullable().optional(),
});

export const nativeCodexCredentialsSchema = z.object({
  tokens: nativeCodexTokensSchema,
}).passthrough();

export type OAuthEntryInput = z.infer<typeof oauthEntrySchema>;
export type AuthStatusOutput = z.infer<typeof authStatusSchema>;
export type TokenWizardInput = z.infer<typeof tokenWizardInputSchema>;
