import { createHash } from "node:crypto";

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function fingerprint(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function asNullableText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

export function uniqueSorted(values) {
  return [...new Set(values.filter((value) => value != null))].sort((a, b) =>
    String(a).localeCompare(String(b)),
  );
}

export function clone(value) {
  return structuredClone(value);
}
