import { z } from "zod";
import { PublicError } from "./asc-errors.mjs";

const policyName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const alias = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const appId = z.string().regex(/^\d{1,32}$/);
const rule = z.strictObject({ allow: z.array(z.string()).max(500), deny: z.array(z.string()).max(500).optional() });
const configuration = z.strictObject({
  idleTimeoutMs: z.number().int().min(100).max(3_600_000).default(120_000),
  apps: z.record(alias, z.union([appId, z.strictObject({ id: appId, policy: policyName })])),
  policies: z.record(policyName, rule).optional(),
  team: z.strictObject({ enabled: z.boolean().default(false), policy: policyName.optional() }).optional()
});

export function parseConfiguration(input) {
  if (input && typeof input === "object" && !Array.isArray(input) &&
      !Object.hasOwn(input, "apps") &&
      Object.values(input).every(value => typeof value === "string" && /^\d{1,32}$/.test(value))) {
    input = { apps: input };
  }
  const parsed = configuration.safeParse(input);
  if (!parsed.success) throw new PublicError("Invalid configuration. Check apps, policies, team and idleTimeoutMs.");
  const config = parsed.data;
  const legacy = !config.policies && Object.values(config.apps).every(value => typeof value === "string") && !config.team?.enabled;
  if (!legacy) {
    for (const entry of Object.values(config.apps)) {
      if (typeof entry === "string" || !config.policies || !Object.hasOwn(config.policies, entry.policy)) {
        throw new PublicError("Each app needs an ID and a policy defined in policies.");
      }
    }
  }
  if (config.team?.enabled && (!config.policies || !Object.hasOwn(config.policies, config.team.policy))) throw new PublicError("Enabled team scope needs a defined policy.");
  if (!Object.keys(config.apps).length && !config.team?.enabled) throw new PublicError("Configure at least one app or explicitly enable team scope.");
  return {
    ...config, legacy,
    appIds: Object.fromEntries(Object.entries(config.apps).map(([name, value]) => [name, typeof value === "string" ? value : value.id]))
  };
}

export const validateConfig = parseConfiguration;
