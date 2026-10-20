/**
 * A replica's fingerprint: SHA-256 over every table's rows, sorted by id, as canonical JSON. The server and a replica
 * compute it over the same contract-shaped rows, so equal fingerprints mean equal data; a mismatch means the replica
 * drifted and must start over. Browser-safe (Web Crypto, which Node has too).
 */

type Row = { id: string | number };

export async function digest(tables: readonly (readonly Row[])[]): Promise<string> {
  const text = JSON.stringify(
    tables.map((rows) =>
      rows.toSorted((a, b) =>
        String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0
      )
    )
  );

  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
