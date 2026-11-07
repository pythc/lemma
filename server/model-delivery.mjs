import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";

const context = new AsyncLocalStorage(),
  requests = new WeakMap();
channel("undici:request:create").subscribe(({ request }) => {
  const delivery = context.getStore();
  if (delivery) {
    delivery.requestCreated = true;
    delivery.requestCreatedAt = new Date().toISOString();
    requests.set(request, delivery);
  }
});
channel("undici:client:sendHeaders").subscribe(({ request }) => {
  const delivery = requests.get(request);
  if (delivery) {
    delivery.headersSent = true;
    delivery.headersSentAt = new Date().toISOString();
  }
});

export async function trackModelDelivery(action) {
  const delivery = {
    requestCreated: false,
    headersSent: false,
    responseHeadersReceived: false,
  };
  try {
    const result = await context.run(delivery, action);
    delivery.responseHeadersReceived = true;
    delivery.responseHeadersAt = new Date().toISOString();
    result.modelDelivery = { ...delivery };
    return result;
  } catch (e) {
    const codes = [];
    for (
      let cause = e, depth = 0;
      cause && depth < 5;
      cause = cause.cause, depth++
    )
      if (typeof cause.code === "string") codes.push(cause.code);
    const connectionFailure = codes.some((c) =>
      [
        "ENOTFOUND",
        "EAI_AGAIN",
        "ECONNREFUSED",
        "ENETUNREACH",
        "EHOSTUNREACH",
        "UND_ERR_CONNECT_TIMEOUT",
      ].includes(c),
    );
    e.modelDelivery = {
      ...delivery,
      codes,
      outcome:
        delivery.requestCreated && !delivery.headersSent && connectionFailure
          ? "not_sent"
          : "unknown",
    };
    throw e;
  }
}

export function knownGenerationLimit(record) {
  return (
    record?.finishReason === "length" &&
    record?.http?.truncated === false &&
    record.http.bodyDigestScope === "complete_body" &&
    record.http.status >= 200 &&
    record.http.status < 300
  );
}

export function infrastructureFailure(error) {
  const record = error?.modelRecord || error;
  if (knownGenerationLimit(record)) return false;
  const code = record?.error?.code || "";
  return (
    /model_(connection_unavailable|dispatch_blocked|transport_error|timeout|nonfinal|no_final|incomplete)/.test(
      code,
    ) ||
    (code === "model_http_error" &&
      [401, 402, 403, 429, 500, 502, 503, 504].includes(record?.http?.status))
  );
}

export function unknownModelOutcome(record) {
  if (knownGenerationLimit(record)) return false;
  if (
    record.error?.delivery?.outcome === "not_sent" ||
    record.error?.delivery?.outcome === "received" ||
    record.resource?.executionStarted === false
  )
    return false;
  return (
    /model_(transport_error|incomplete|timeout|cancelled|nonfinal|no_final)/.test(
      record.error?.code || "",
    ) ||
    !record.http?.status ||
    record.http.status >= 500
  );
}

export function providerAccountBlocked(error) {
  const record = error?.modelRecord || error;
  return (
    record?.error?.code === "model_http_error" && record?.http?.status === 402
  );
}
