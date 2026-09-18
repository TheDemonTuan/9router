import { createRemoteJWKSet, jwtVerify } from "jose";

let jwks = null;

/**
 * Verify Cloudflare Access JWT assertion header or CF_Authorization cookie.
 * When CLOUDFLARE_ACCESS_TEAM_NAME and CLOUDFLARE_ACCESS_AUD are configured,
 * requests arriving through Cloudflare Access are authenticated automatically.
 */
export async function verifyCloudflareAccessJwt(token) {
  if (!token) return false;
  const teamName = process.env.CLOUDFLARE_ACCESS_TEAM_NAME;
  const audience = process.env.CLOUDFLARE_ACCESS_AUD;
  if (!teamName || !audience) return false;

  try {
    if (!jwks) {
      jwks = createRemoteJWKSet(
        new URL(`https://${teamName}.cloudflareaccess.com/cdn-cgi/access/certs`)
      );
    }
    const { payload } = await jwtVerify(token, jwks, {
      audience,
      issuer: `https://${teamName}.cloudflareaccess.com`,
    });
    return !!payload;
  } catch {
    return false;
  }
}
