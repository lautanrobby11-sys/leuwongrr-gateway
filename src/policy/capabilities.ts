export type Capability = 'text'|'tools'|'vision'|'stream';
export interface ModelPolicy {
  publicId: string;
  upstreamModel: string;
  capabilities: ReadonlySet<Capability>;
  maxOutputTokens: number;
  enabled: boolean;
}

const registry = new Map<string, ModelPolicy>([
  ['lwrr-text', {
    publicId: 'lwrr-text', upstreamModel: 'auto',
    capabilities: new Set<Capability>(['text','stream']),
    maxOutputTokens: 4096, enabled: true
  }]
]);

export function listModels(): ModelPolicy[] {
  return [...registry.values()].filter((m) => m.enabled);
}

export function requireModel(id: string, required: readonly Capability[]): ModelPolicy {
  const model = registry.get(id);
  if (!model?.enabled) throw new PolicyError('model_not_available', 404);
  for (const capability of required) {
    if (!model.capabilities.has(capability)) throw new PolicyError(`capability_${capability}_unsupported`, 400);
  }
  return model;
}

export class PolicyError extends Error {
  constructor(public readonly code: string, public readonly statusCode: number) { super(code); }
}
