import { z } from "zod";

/**
 * Lenient OTLP/HTTP JSON trace request (opentelemetry-proto, trace/v1 and collector/trace/v1). Unknown fields are ignored
 * (the spec requires receivers to), both lowerCamelCase and the original snake_case names are accepted (proto3 JSON
 * parsers must), and 64-bit integers may arrive as strings or numbers. Only what the mapper reads is described.
 */
const num = z.union([z.string(), z.number()]);
const anyValue = z.looseObject({
  stringValue: z.string().optional(),
  string_value: z.string().optional(),
  intValue: num.optional(),
  int_value: num.optional(),
  doubleValue: z.number().optional(),
  double_value: z.number().optional(),
  boolValue: z.boolean().optional(),
  bool_value: z.boolean().optional(),
});
const keyValue = z.looseObject({ key: z.string(), value: anyValue.nullish() });
const attributes = z.array(keyValue).optional();
const status = z.looseObject({ code: num.optional(), message: z.string().optional() });
const spanEvent = z.looseObject({ name: z.string().optional(), attributes });

const span = z.looseObject({
  traceId: z.string().optional(),
  trace_id: z.string().optional(),
  spanId: z.string().optional(),
  span_id: z.string().optional(),
  parentSpanId: z.string().optional(),
  parent_span_id: z.string().optional(),
  name: z.string().optional(),
  startTimeUnixNano: num.optional(),
  start_time_unix_nano: num.optional(),
  endTimeUnixNano: num.optional(),
  end_time_unix_nano: num.optional(),
  attributes,
  events: z.array(spanEvent).optional(),
  status: status.nullish(),
});

const scopeSpans = z.looseObject({ spans: z.array(span).optional() });
const resourceSpans = z.looseObject({
  resource: z.looseObject({ attributes }).nullish(),
  scopeSpans: z.array(scopeSpans).optional(),
  scope_spans: z.array(scopeSpans).optional(),
});

export const otlpTraceRequest = z.looseObject({
  resourceSpans: z.array(resourceSpans).optional(),
  resource_spans: z.array(resourceSpans).optional(),
});

export type OtlpTraceRequest = z.infer<typeof otlpTraceRequest>;
export type OtlpSpan = z.infer<typeof span>;
export type OtlpKeyValue = z.infer<typeof keyValue>;
