import { AI_PROVIDERS } from "@/shared/constants/providers";
import { sanitizeProviderSpecificData } from "@/lib/providerNormalization";

export function usesAwsCredentialForm(provider) {
  return AI_PROVIDERS[provider]?.credentialForm === "aws";
}

export function toProviderConnectionResponse(connection) {
  const { apiKey, accessToken, refreshToken, idToken, ...safe } = connection;

  if (!connection.providerSpecificData) return safe;

  return {
    ...safe,
    providerSpecificData: sanitizeProviderSpecificData(connection.providerSpecificData),
  };
}
