import type { CaaRecord } from '../types.js';

/**
 * Whether a domain's CAA records still allow the authority that issued its
 * certificate.
 *
 * A certificate already issued keeps working whatever CAA says, which is what makes
 * this easy to miss: someone adds a CAA record naming another authority, nothing
 * breaks, and the next automatic renewal fails months later.
 */

/**
 * The CAA identifiers each authority recognises, by the organisation named in the
 * certificates it issues.
 *
 * From the Common CA Database's public report, for the authorities common enough to
 * be worth a maintained entry. An issuer missing from here produces no verdict
 * rather than a wrong one, because a false "your next renewal will fail" is worse
 * than saying nothing.
 *
 * @see https://ccadb.my.salesforce-sites.com/ccadb/AllCAAIdentifiersReportCSV
 */
const CAA_IDENTIFIERS: Record<string, readonly string[]> = {
  "Let's Encrypt": ['letsencrypt.org'],
  'Google Trust Services': ['pki.goog'],
  'Google Trust Services LLC': ['pki.goog'],
  'DigiCert Inc': [
    'digicert.com',
    'www.digicert.com',
    'digicert.ne.jp',
    'cybertrust.ne.jp',
    'thawte.com',
    'geotrust.com',
    'rapidssl.com',
    'symantec.com',
    'digitalcertvalidation.com',
    'quovadisglobal.com',
  ],
  'Sectigo Limited': [
    'sectigo.com',
    'comodo.com',
    'comodoca.com',
    'usertrust.com',
    'trust-provider.com',
    'entrust.net',
    'affirmtrust.com',
  ],
  Amazon: [
    'amazon.com',
    'amazontrust.com',
    'awstrust.com',
    'amazonaws.com',
    'aws.amazon.com',
    'amazontrustservices.eu',
    'amazonaws.eu',
    'amznts.eu',
  ],
  'GlobalSign nv-sa': ['globalsign.com'],
  'SSL Corporation': ['ssl.com'],
};

/**
 * Judges whether CAA allows a certificate's issuer to issue its replacement.
 *
 * Only `issue` and `issuewild` decide this. A wildcard certificate follows
 * `issuewild` when any is published and falls back to `issue`, as RFC 8659 §4.3
 * says.
 *
 * @param records The domain's CAA records.
 * @param issuerOrganization The organisation that issued the certificate.
 * @param wildcard Whether the certificate covers the host through a wildcard.
 * @returns `true` when allowed, `false` when the records exclude that issuer, and
 *   `null` when nothing can be said: no record restricts issuance, or the issuer is
 *   not one this project has identifiers for.
 * @throws Never.
 */
export function caaAllowsIssuer(
  records: readonly CaaRecord[],
  issuerOrganization: string | null,
  wildcard: boolean,
): boolean | null {
  const wild = records.flatMap((record) =>
    record.issuewild === undefined ? [] : [record.issuewild],
  );
  const plain = records.flatMap((record) => (record.issue === undefined ? [] : [record.issue]));
  const relevant = wildcard && wild.length > 0 ? wild : plain;
  if (relevant.length === 0) return null;

  const identifiers = issuerOrganization === null ? undefined : CAA_IDENTIFIERS[issuerOrganization];
  if (identifiers === undefined) return null;

  // Parameters follow a `;` (`letsencrypt.org; accounturi=…`), and a bare `;` is a
  // record saying that nobody may issue.
  return relevant
    .map((value) => (value.split(';')[0] ?? '').trim().toLowerCase())
    .some((domain) => identifiers.includes(domain));
}
