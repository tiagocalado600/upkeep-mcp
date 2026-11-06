/**
 * What each finding means to someone who does not run the website.
 *
 * A finding's `message` is written for whoever maintains the site, and it is the
 * record of what was measured. A client report needs something else: the same fact
 * in words a business owner reads, and the same words every quarter, which a model
 * rewriting the message each time cannot promise.
 *
 * Keyed by the stable `code`, so a reworded message changes nothing here.
 * `test/lib/finding-catalog.test.ts` reads every code out of `src/` and fails when
 * one has no entry, so this cannot quietly fall behind the checks.
 */

/** A finding, for a reader who does not maintain the site. */
export interface FindingExplanation {
  /** What it means, in plain language. */
  plain: string;
  /**
   * Whether acting on it needs the client: money, a decision, or access only they
   * hold. Everything else is the maintainer's to deal with.
   */
  needsClient: boolean;
}

/** Shorthand for an entry the maintainer can act on alone. */
const ours = (plain: string): FindingExplanation => ({ plain, needsClient: false });

/** Shorthand for an entry that needs the client. */
const theirs = (plain: string): FindingExplanation => ({ plain, needsClient: true });

const CATALOG: Record<string, FindingExplanation> = {
  // Registration and DNS.
  domain_expired: theirs(
    'The domain name has expired, and the site and email can stop at any moment.',
  ),
  domain_expires_soon: theirs('The domain name is close to its renewal date and needs renewing.'),
  domain_not_registered: theirs('This domain name is not registered to anyone.'),
  domain_on_hold: theirs('The registry has put the domain on hold, which takes the site offline.'),
  domain_pending_delete: theirs('The domain is being deleted by the registry and may be lost.'),
  domain_does_not_resolve: ours('The domain name does not lead anywhere at the moment.'),
  apex_does_not_resolve: ours(
    'The address without "www" does not work, so some visitors will not arrive.',
  ),
  dns_lookup_failed: ours(
    "The domain's settings could not be read this time, so they were not checked.",
  ),
  registration_expiry_unavailable: ours(
    'The registry does not publish the renewal date, so it needs checking by hand.',
  ),
  registration_lookup_failed: ours(
    'The renewal date could not be read this time, so it was not checked.',
  ),
  dnssec_not_enabled: ours(
    'An optional protection against forged domain answers is not switched on.',
  ),
  dnssec_broken: ours(
    'A domain security setting is broken, which can make the site unreachable and block certificate renewal.',
  ),
  nameserver_does_not_resolve: ours(
    'One of the servers responsible for the domain cannot be found.',
  ),
  nameserver_not_asked: ours('One of the servers responsible for the domain could not be checked.'),
  nameserver_not_authoritative: ours(
    'One of the servers listed for the domain does not recognise it.',
  ),
  nameservers_disagree: ours('The servers responsible for the domain give different answers.'),
  nameservers_not_established: ours('The servers responsible for the domain could not be checked.'),

  // Email.
  spf_not_published: ours(
    'The domain does not say which servers may send its email, so messages may land in spam or be forged.',
  ),
  spf_allows_any_sender: ours('The domain allows anyone to send email in its name.'),
  spf_multiple_records: ours('The email sender settings are duplicated, which makes them invalid.'),
  spf_no_policy_for_unlisted: ours(
    'The email settings do not say what to do with mail from unknown senders.',
  ),
  spf_too_many_lookups: ours('The email sender settings are too long to work reliably.'),
  dmarc_not_published: ours(
    'The domain has no anti-forgery email policy, which large providers now expect from bulk senders.',
  ),
  dmarc_multiple_records: ours(
    'The anti-forgery email policy is duplicated, which makes it invalid.',
  ),
  dmarc_not_enforcing: ours(
    'The anti-forgery email policy only observes, so forged mail is still delivered.',
  ),
  dmarc_no_reporting_address: ours(
    "Nobody receives the reports about mail forged in this domain's name.",
  ),
  dmarc_policy_invalid: ours(
    'The anti-forgery email policy is written incorrectly and is being ignored.',
  ),

  // Certificates.
  cert_expired: ours(
    'The security certificate has expired, so visitors see a warning instead of the site.',
  ),
  cert_expires_soon: ours(
    'The security certificate is close to expiring and has not renewed itself yet.',
  ),
  cert_long_lived: ours(
    'The security certificate appears to be renewed by hand, which will soon be needed far more often.',
  ),
  cert_renewal_overdue: ours(
    'The security certificate should have renewed itself by now, so its automatic renewal has probably stopped.',
  ),
  cert_revoked: ours(
    'The issuer has cancelled this security certificate, so it needs replacing now.',
  ),
  cert_revoked_unverified: ours(
    'There is an unconfirmed report that this security certificate was cancelled.',
  ),
  cert_dates_unavailable: ours('The expiry date of the security certificate could not be read.'),
  chain_invalid: ours(
    'The security certificate is not set up correctly, so visitors may see a warning.',
  ),
  host_not_covered: ours(
    'The security certificate does not cover this address, so visitors see a warning.',
  ),
  apex_not_covered: ours('The security certificate does not cover the address without "www".'),
  www_not_covered: ours('The security certificate does not cover the "www" address.'),
  www_coverage_unjudged: ours(
    'Whether the certificate needs to cover the "www" address could not be checked.',
  ),
  tls_version_outdated: ours(
    'The site uses an outdated version of the encryption that protects visitors.',
  ),
  caa_excludes_issuer: ours(
    "A domain setting no longer allows this certificate's issuer, so its next renewal will fail.",
  ),
  revocation_answer_unverified: ours(
    'Whether the certificate has been cancelled could not be confirmed.',
  ),
  revocation_check_failed: ours(
    'Whether the certificate has been cancelled could not be checked this time.',
  ),
  revocation_status_unknown: ours(
    'The issuer does not say whether this certificate has been cancelled.',
  ),

  // Availability.
  server_error: ours('The site is answering with a server error, so visitors cannot use it.'),
  page_not_found: ours('The address being monitored shows a "page not found" error.'),
  client_error: ours('The site refused the request with an error.'),
  access_restricted: ours('The site asks for a login or refuses visitors at this address.'),
  rate_limited: ours('The site asked this check to slow down, so the result is incomplete.'),
  redirect_loop: ours('The address redirects in a circle, so visitors never reach the site.'),
  redirect_chain_long: ours(
    'The address passes through several redirects, which slows visitors down.',
  ),
  redirect_chain_too_long: ours('The address redirects too many times, and browsers may give up.'),
  redirect_target_unreachable: ours('The address redirects to somewhere that cannot be reached.'),
  no_https_redirect: ours('Visitors on the unencrypted address are not sent to the secure one.'),

  // Security headers.
  hsts_missing: ours('Browsers are not told to always use the secure version of the site.'),
  hsts_disabled: ours(
    'The setting that keeps browsers on the secure version of the site is switched off.',
  ),
  csp_missing: ours('An optional protection against malicious scripts is not set up.'),
  csp_report_only: ours(
    'The protection against malicious scripts only reports and does not block anything.',
  ),
  nosniff_missing: ours('A small browser security setting is missing.'),
  dead_headers_present: ours('The site sends old security settings that browsers no longer use.'),

  // Search.
  title_missing: ours('A page has no title, which is what search results show.'),
  title_long: ours('A page title is too long and will be cut off in search results.'),
  meta_description_missing: ours('A page has no summary for search results to show.'),
  meta_description_long: ours('A page summary is too long and will be cut off in search results.'),
  meta_noindex: ours('A page is asking search engines not to list it.'),
  canonical_missing: ours(
    'A page does not say which address is its main one, which can split its search ranking.',
  ),
  h1_missing: ours('A page has no main heading.'),
  h1_multiple: ours('A page has more than one main heading.'),
  heading_level_skipped: ours("A page's headings skip a level, which makes it harder to navigate."),
  images_missing_alt: ours(
    'Some images have no description, which affects screen reader users and search.',
  ),
  lang_missing: ours('A page does not declare its language.'),
  viewport_missing: ours('A page is not set up for mobile screens.'),
  open_graph_incomplete: ours('Links to this page may look bare when shared on social media.'),
  broken_internal_links: ours('Some links on the site lead nowhere.'),
  links_not_checked: ours('The links on this page were not checked.'),
  links_unchecked: ours('Some links on this page were not checked.'),
  links_redirect_off_the_site: ours("Some of the site's links send visitors to another website."),
  not_html: ours('The address does not return a web page.'),
  page_unavailable: ours('The page could not be read this time.'),
  page_disallowed_by_robots: ours(
    'The site asks automated checks not to read this page, so it was not checked.',
  ),
  document_too_deeply_nested: ours("The page's code is too deeply nested to be checked."),
  document_truncated: ours('The page is very large, so only the first part was checked.'),
  robots_txt_absent: ours(
    'The site has no file telling search engines how to read it, which is usually fine.',
  ),
  robots_txt_unreachable: ours(
    'The file telling search engines how to read the site could not be fetched.',
  ),
  sitemap_missing: ours('The site has no list of its pages for search engines.'),
  sitemap_unusable: ours('The list of pages for search engines could not be read.'),
  sitemap_truncated: ours('The list of pages for search engines is too large to read completely.'),

  // Site-wide crawl.
  crawl_found_nothing: ours('Checking the site found no pages to read.'),
  crawl_incomplete: ours('Not every page of the site was checked.'),
  duplicate_titles: ours(
    'Several pages share the same title, which makes them compete in search results.',
  ),
  duplicate_meta_descriptions: ours('Several pages share the same summary for search results.'),
  pages_without_a_title: ours('Some pages have no title.'),
  pages_without_a_meta_description: ours('Some pages have no summary for search results.'),
  pages_without_an_h1: ours('Some pages have no main heading.'),
  pages_asking_not_to_be_indexed: ours('Some pages are asking search engines not to list them.'),
  pages_disallowed_by_robots: ours('The site asks automated checks not to read some of its pages.'),

  // Accessibility.
  a11y_further_violations: ours('There are further accessibility problems beyond those listed.'),
  a11y_needs_review: ours('Some accessibility points need checking by a person.'),
  a11y_automated_checks_passed: ours(
    'The automated accessibility checks passed, which covers only part of what the law asks.',
  ),

  // The report itself.
  no_checks_ran: ours('No checks ran for this site, so nothing is known about it.'),
};

/** Codes built at runtime, explained by what they start or end with. */
const PATTERNS: readonly { matches: (code: string) => boolean; entry: FindingExplanation }[] = [
  {
    matches: (code) => code.startsWith('a11y_'),
    entry: ours('Part of the site is harder or impossible to use for people with disabilities.'),
  },
  {
    matches: (code) => code.startsWith('sitemap_'),
    entry: ours('The list of pages for search engines has a mistake in it.'),
  },
  {
    matches: (code) => code.endsWith('_check_failed'),
    entry: ours('This check could not run this time, so nothing is known from it.'),
  },
];

/**
 * Explains a finding for someone who does not maintain the site.
 *
 * @param code The finding's stable code.
 * @returns The entry, or `null` when there is none. A caller falls back to the
 *   finding's own message rather than to invented words.
 * @throws Never.
 */
export function explainFinding(code: string): FindingExplanation | null {
  return (
    (Object.hasOwn(CATALOG, code) ? CATALOG[code] : undefined) ??
    PATTERNS.find((pattern) => pattern.matches(code))?.entry ??
    null
  );
}
