import {
  STRICT_AUDIT_BINDING_PROTOCOL,
  strictAuditRequest,
  validateStrictEndpoint,
} from "./strict-audit.mjs";
import { ANCHORED_AUDIT_PROTOCOL } from "./audit-wire.mjs";
import { digest } from "./evidence.mjs";
// Explicit evaluation opt-in only; defaults and the R03 endpoint are unchanged.
export function selectStrictAuditConfig(config, env = process.env) {
  const selected = env.LEMMA_AUDIT_BINDING_PROTOCOL;
  if (!selected) return config;
  if (!config?.model || !config?.key)
    throw Error(
      "Strict evaluation requires a complete local model configuration",
    );
  if (selected !== STRICT_AUDIT_BINDING_PROTOCOL)
    throw Error(
      "Only the current strict receiving protocol can be explicitly selected",
    );
  if (!env.LEMMA_STRICT_AUDIT_ENDPOINT)
    throw Error(
      "Explicit strict semantic endpoint required; no automatic Beta redirect",
    );
  const result = {
    ...config,
    endpoint: env.LEMMA_STRICT_AUDIT_ENDPOINT,
    auditBindingProtocol: selected,
    semanticProtocol: ANCHORED_AUDIT_PROTOCOL,
  };
  validateStrictEndpoint(result);
  return result;
}
export function strictAuditConfigurationPreview(config, input, system) {
  if (
    config.auditBindingProtocol !== STRICT_AUDIT_BINDING_PROTOCOL ||
    input.context.auditBindingProtocol !== STRICT_AUDIT_BINDING_PROTOCOL
  )
    throw Error("Preview requires the current strict receiving protocol");
  validateStrictEndpoint(config);
  const request = strictAuditRequest(input, system);
  return {
    classification:
      "configuration_preview_no_inference_no_network_not_supplier_acceptance",
    model: config.model,
    endpoint: config.endpoint,
    family: config.family || "unknown",
    auditBindingProtocol: config.auditBindingProtocol,
    semanticProtocol: input.context.semanticProtocol,
    thinking: request.thinking,
    request,
    configurationHash: digest(config),
    statisticallyIndependentExperts: false,
  };
}
