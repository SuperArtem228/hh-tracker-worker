// Быстрый детерминированный хэш для дедупликации.
// Не крипто. Но для "уникальности откликов" достаточно.

export function fnv1a64Hex(input: string): string {
  let hash = 0xcbf29ce484222325n; // FNV offset basis
  const prime = 0x100000001b3n; // FNV prime
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}
