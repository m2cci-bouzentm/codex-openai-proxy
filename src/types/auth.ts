import type {
  CanonicalOAuthContract,
  AuthStatusContract,
} from "../schemas/contracts.schema";

export type OAuthEntry = CanonicalOAuthContract;
export type AuthStatus = AuthStatusContract;

export interface AuthResult {
  accessToken: string;
  accountId: string;
}

export interface TokenResponse {
  id_token?: string;
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}
