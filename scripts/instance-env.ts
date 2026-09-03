/**
 * Builds the PUBLIC_URL the instance .env ships with. The Lambda authorizer
 * derives its own copy at `sst deploy` (sst.config.ts resolvePublicUrl) and
 * rejects tokens minted for any other URL, so the two must resolve identically
 * — deploy.yml's "Resolve public URL" step applies this rule for CI deploys,
 * and these helpers apply it for laptop deploys (scripts/dev.ts lightsail:up).
 */

type PublicUrlSource = "PUBLIC_URL" | "CUSTOM_DOMAIN" | "API Gateway"

export type ResolvedPublicUrl = {
  url: string
  source: PublicUrlSource
}

export const resolvePublicUrl = ({
  publicUrl,
  customDomain,
  queryGatewayUrl,
}: {
  publicUrl: string | undefined
  customDomain: string | undefined
  // A thunk so the aws CLI is only invoked when neither value is set.
  queryGatewayUrl: () => string
}): ResolvedPublicUrl => {
  if (publicUrl) return { url: publicUrl, source: "PUBLIC_URL" }
  if (customDomain)
    return { url: `https://${customDomain}`, source: "CUSTOM_DOMAIN" }

  // `aws --output text` prints the literal "None" for an empty query result.
  const gatewayUrl = queryGatewayUrl()
  if (!gatewayUrl || gatewayUrl === "None") {
    throw new Error(
      "could not resolve the public URL from PUBLIC_URL, CUSTOM_DOMAIN, or the API Gateway",
    )
  }
  return { url: gatewayUrl, source: "API Gateway" }
}

/**
 * Returns the .env content with its PUBLIC_URL line set to the resolved
 * value — replaced in place when a line exists (including an empty
 * `PUBLIC_URL=`), appended otherwise. Commented lines are left alone.
 */
export const envContentWithPublicUrl = (
  envFileContent: string,
  publicUrl: string,
): string => {
  const publicUrlLine = `PUBLIC_URL=${publicUrl}`
  const lines = envFileContent.split("\n")
  const hasPublicUrlLine = lines.some((line) => line.startsWith("PUBLIC_URL="))

  if (hasPublicUrlLine) {
    return lines
      .map((line) => (line.startsWith("PUBLIC_URL=") ? publicUrlLine : line))
      .join("\n")
  }

  const separator =
    envFileContent === "" || envFileContent.endsWith("\n") ? "" : "\n"
  return `${envFileContent}${separator}${publicUrlLine}\n`
}
