/**
 * Money as integers in a currency's minor units (cents for USD, none for JPY), so sums are exact and a malformed
 * amount can't hide as a float or a zero. Browser-safe.
 */

const digits = new Map<string, number>();

/** How many minor-unit digits `currency` has: from Intl for ISO codes, 2 for anything Intl doesn't know. */
export function fractionDigits(currency: string): number {
  let found = digits.get(currency);

  if (found === undefined) {
    try {
      found =
        new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
          .maximumFractionDigits ?? 2;
    } catch {
      found = 2;
    }

    digits.set(currency, found);
  }

  return found;
}

/** A decimal amount in minor units; throws for an amount that isn't a finite number or doesn't fit. */
export function minorUnits(amount: number, currency: string): number {
  const value = Math.round(amount * 10 ** fractionDigits(currency));

  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${amount} ${currency} is not an amount`);
  }

  return value;
}

const formats = new Map<number, Intl.NumberFormat>();

/** Minor units as text with grouping and the currency's digits, no symbol: `1,234.50`. */
export function formatMinor(value: number, currency: string): string {
  const places = fractionDigits(currency);
  let format = formats.get(places);

  if (format === undefined) {
    format = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: places,
      maximumFractionDigits: places,
    });
    formats.set(places, format);
  }

  return format.format(value / 10 ** places);
}
