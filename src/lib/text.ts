/**
 * Ends a sentence with exactly one full stop.
 *
 * For sentences that end in something this project did not write: a registrar
 * called "MarkMonitor Inc." or an issuer called "Example Trust Services Ltd."
 * already carries its own full stop, and appending another printed
 * "Registrar: MarkMonitor Inc.." in a report meant for a client.
 *
 * @param text A sentence, possibly ending in a name that ends in punctuation.
 * @returns The same sentence, with a full stop appended only when it does not
 *   already end in `.`, `!` or `?`.
 * @throws Never.
 */
export function sentence(text: string): string {
  const trimmed = text.trimEnd();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
