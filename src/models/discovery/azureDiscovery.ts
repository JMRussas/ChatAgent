// Source: Microsoft Learn REST API reference, "Deployments - List" (Azure AI
// Services account management, api-version 2024-10-01), verified 2026-09-29:
// https://learn.microsoft.com/en-us/rest/api/aiservices/accountmanagement/deployments/list
// The direct Azure OpenAI resource endpoint's own deployments-list API
// (/openai/deployments?api-version=2023-03-15-preview) was retired in 2024;
// listing deployments now requires the ARM management plane and a separate
// AAD app-registration credential (client-credentials grant), distinct from
// the AZURE_OPENAI_API_KEY used for the actual chat-completions data plane.
import type { Connection } from "../connections";
import type { DiscoveryAdapter, DiscoveryObservation } from "../inventory";
import { bindingKey } from "../connections";

const ARM_API_VERSION = "2024-10-01";
const MAX_PAGES = 20;

interface ArmDeployment {
  name?: string;
  properties?: {
    model?: { name?: string; version?: string };
    provisioningState?: string;
  };
}

interface ArmDeploymentListResult {
  value?: ArmDeployment[];
  nextLink?: string;
}

interface AzureArmCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
  resourceGroup: string;
  accountName: string;
}

function readArmCredentialsFromEnv(env: NodeJS.ProcessEnv): AzureArmCredentials {
  const required = [
    "AZURE_ARM_TENANT_ID",
    "AZURE_ARM_CLIENT_ID",
    "AZURE_ARM_CLIENT_SECRET",
    "AZURE_ARM_SUBSCRIPTION_ID",
    "AZURE_ARM_RESOURCE_GROUP",
    "AZURE_ARM_ACCOUNT_NAME"
  ] as const;
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Azure deployment discovery requires ${missing.join(", ")} (management-plane credentials, separate from AZURE_OPENAI_API_KEY).`
    );
  }

  return {
    tenantId: env.AZURE_ARM_TENANT_ID!,
    clientId: env.AZURE_ARM_CLIENT_ID!,
    clientSecret: env.AZURE_ARM_CLIENT_SECRET!,
    subscriptionId: env.AZURE_ARM_SUBSCRIPTION_ID!,
    resourceGroup: env.AZURE_ARM_RESOURCE_GROUP!,
    accountName: env.AZURE_ARM_ACCOUNT_NAME!
  };
}

async function getArmAccessToken(
  credentials: AzureArmCredentials,
  signal: AbortSignal
): Promise<string> {
  const response = await fetch(
    `https://login.microsoftonline.com/${credentials.tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        scope: "https://management.azure.com/.default",
        grant_type: "client_credentials"
      }),
      signal
    }
  );

  if (!response.ok) throw new Error(`Azure AD token request failed (${response.status})`);
  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) throw new Error("Azure AD token response is missing access_token");
  return payload.access_token;
}

async function listAllDeployments(
  credentials: AzureArmCredentials,
  token: string,
  signal: AbortSignal
): Promise<ArmDeployment[]> {
  const base = `https://management.azure.com/subscriptions/${credentials.subscriptionId}/resourceGroups/${credentials.resourceGroup}/providers/Microsoft.CognitiveServices/accounts/${credentials.accountName}/deployments?api-version=${ARM_API_VERSION}`;
  const deployments: ArmDeployment[] = [];
  let url: string | undefined = base;

  for (let page = 0; url && page < MAX_PAGES; page += 1) {
    const response: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal
    });
    if (!response.ok) throw new Error(`Azure ARM deployments list failed (${response.status})`);
    const payload = (await response.json()) as ArmDeploymentListResult;
    deployments.push(...(payload.value ?? []));
    url = payload.nextLink;
  }

  return deployments;
}

export class AzureDiscoveryAdapter implements DiscoveryAdapter {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async discover(connection: Connection, signal: AbortSignal): Promise<DiscoveryObservation[]> {
    const credentials = readArmCredentialsFromEnv(this.env);
    const token = await getArmAccessToken(credentials, signal);
    const deployments = await listAllDeployments(credentials, token, signal);
    const observedAtIso = new Date().toISOString();

    return deployments
      .filter(
        (deployment): deployment is ArmDeployment & { name: string } =>
          typeof deployment.name === "string"
      )
      .map(
        (deployment) =>
          ({
            bindingId: bindingKey(connection.connectionId, "azure-openai-chat", deployment.name),
            connectionId: connection.connectionId,
            model: deployment.name,
            revision: deployment.properties?.model?.version,
            observedAtIso,
            source: "azure-arm-deployments-list",
            installed: "yes",
            // Management-plane list permission does not imply the configured
            // AZURE_OPENAI_API_KEY can actually invoke this deployment -- those
            // are different credentials on different planes.
            access: "unknown",
            health:
              deployment.properties?.provisioningState === "Succeeded"
                ? "reachable"
                : "unreachable",
            apiCompatibility: ["azure-openai-chat"]
          }) satisfies DiscoveryObservation
      );
  }
}
