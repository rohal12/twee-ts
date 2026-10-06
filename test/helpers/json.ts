/** Whether a value is a plain JSON object (not null, not an array). */
function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses JSON that must hold an object; throws when it does not, so the test fails there. */
export function parseJsonObject(text: string): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(text);
  if (!isJsonObject(value)) throw new Error(`expected a JSON object, got: ${text.slice(0, 80)}`);
  return value;
}
