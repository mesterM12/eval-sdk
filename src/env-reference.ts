const envReferencePattern = /^env:[A-Za-z_][A-Za-z0-9_]*$/;
const envPrefix = "env:";

export function envReferenceValidationError(value: unknown, label: string, name: string) {
  if (typeof value === "string" && envReferencePattern.test(value)) return undefined;
  return `${label} env ${name} must be an env var reference like env:API_KEY`;
}

export function resolveEnv(env: Record<string, string> | undefined) {
  return Object.fromEntries(Object.entries(env ?? {}).map(([name, value]) => [name, isEnvReference(value) ? process.env[envReferenceName(value)] ?? "" : value]));
}

export function collectEnvSecretValues(envBlocks: Array<Record<string, string> | undefined>) {
  const names = new Set<string>();
  for (const env of envBlocks) {
    for (const value of Object.values(env ?? {})) {
      if (isEnvReference(value)) names.add(envReferenceName(value));
    }
  }
  return [...names].map((name) => process.env[name]).filter((value): value is string => typeof value === "string" && value.length > 0);
}

export function describeEnvForPublicOutput(env: Record<string, string> | undefined) {
  return Object.fromEntries(Object.keys(env ?? {}).map((name) => [name, "[env]"]));
}

export function redactText(text: string, secretValues: string[]) {
  return secretValues.reduce((redacted, secret) => redacted.split(secret).join("[REDACTED]"), text);
}

function isEnvReference(value: string) {
  return value.startsWith(envPrefix);
}

function envReferenceName(value: string) {
  return value.slice(envPrefix.length);
}
