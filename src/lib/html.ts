import {
  type DefaultTreeAdapterMap,
  type DefaultTreeAdapterTypes,
  type ParserOptions,
  type TokenHandler,
  type TokenizerOptions,
  Parser,
  Tokenizer,
  defaultTreeAdapter,
  parse,
} from 'parse5';

/**
 * HTML parsing, reduced to the handful of facts a technical SEO check needs.
 *
 * `parse5` implements the HTML5 tree construction algorithm, which matters more
 * here than it might sound: real client sites serve unclosed tags, stray
 * `</div>`s and metadata after `<body>` has already started, and a tolerant
 * parser that guesses differently from a browser would report problems the
 * visitor never has. Everything below reads the tree a browser would build.
 *
 * The result is plain data, never a node tree: tools consume this module's
 * output and never traverse the DOM themselves.
 */

type Element = DefaultTreeAdapterTypes.Element;
type Node = DefaultTreeAdapterTypes.Node;

/** One heading, in document order. */
export interface Heading {
  /** 1 for `<h1>` through 6 for `<h6>`. */
  level: number;
  /** The heading's visible text, with whitespace collapsed. */
  text: string;
}

/** One `<img>`. */
export interface PageImage {
  /** Resolved absolute URL, or `null` when the element has no usable `src`. */
  src: string | null;
  /**
   * The `alt` attribute.
   *
   * `null` means the attribute is absent, which is an accessibility problem.
   * An empty string means it was written as `alt=""`, which is the correct way
   * to mark an image as decorative and is **not** a problem. Collapsing the two
   * into one "missing alt" count is the most common way this check is got wrong.
   */
  alt: string | null;
}

/** One `<a href>` pointing somewhere over HTTP. */
export interface PageLink {
  /** Resolved absolute URL. */
  href: string;
  /** The `rel` attribute, lowercased, or `null`. */
  rel: string | null;
  /** The link's visible text, with whitespace collapsed. */
  text: string;
}

/** One `<link rel="alternate" hreflang>` declaration. */
export interface AlternateLink {
  /** The language tag as written, e.g. `pt-PT` or `x-default`. */
  hreflang: string;
  /** Resolved absolute URL. */
  href: string;
}

/** Everything extracted from one page. */
export interface PageContent {
  /** The `<title>`, with whitespace collapsed, or `null` when absent or empty. */
  title: string | null;
  /** The `<meta name="description">` content. */
  metaDescription: string | null;
  /** The `<meta name="robots">` content, lowercased. */
  metaRobots: string | null;
  /** The `<link rel="canonical">` target, resolved. */
  canonical: string | null;
  /** The `lang` attribute of `<html>`. */
  lang: string | null;
  /** Whether a `<meta name="viewport">` is present. */
  hasViewport: boolean;
  /** Open Graph properties, keyed without the `og:` prefix, e.g. `title`. */
  openGraph: Record<string, string>;
  /** Every heading, in document order. */
  headings: Heading[];
  /** Every `<img>`, in document order. */
  images: PageImage[];
  /** Every `<a>` resolving to an `http:` or `https:` URL, in document order. */
  links: PageLink[];
  /** Every `<link rel="alternate" hreflang>`. */
  alternates: AlternateLink[];
}

/** Elements whose text is never shown to a reader. */
const NON_RENDERED = new Set(['script', 'style', 'template', 'noscript']);

/**
 * Nesting levels beyond which a document is refused rather than parsed.
 *
 * HTML5 tree construction costs roughly the square of the nesting depth:
 * measured here, 2,500 levels parse in 32ms, 5,000 in 104ms, 10,000 in 396ms
 * and 20,000 in 1.5s. A page is read up to two mebibytes, and two mebibytes of
 * `<div>` is four hundred thousand levels — which extrapolates to several
 * minutes of blocked event loop from a single hostile response. Nothing else can
 * interrupt a synchronous parse, so the parse measures itself and stops the
 * moment the document is known to be absurd.
 *
 * Around five hundred is far past any real page: a deeply nested layout reaches a few
 * dozen, and the worst hand-written table markup a hundred or so. It is that low
 * because depth multiplies with everything else: at 2,000 levels, two mebibytes of
 * `<li>` took 8.4s, since each one walks the stack of open elements.
 */
const MAX_NESTING_DEPTH = 512;

/**
 * Steps of tree construction one parse may take.
 *
 * Capping the depth caps each walk of the stack of open elements, not how many
 * walks there are: two mebibytes of `<li>` or `</h1>` under five hundred `<div>`s
 * stays within the depth limit and still took seven to nine seconds, every tag
 * walking the whole stack. Nearly every such walk asks the tree adapter for an
 * element's namespace, so each of those calls is a step. The other quadratic
 * path is a sibling list: foster parenting inserts before a `<table>` by
 * searching its parent's children, so `<table><math>` repeated took seventeen
 * seconds. Those lists are now searched from the end, where the table nearly
 * always is, and each insertion or removal costs as many steps as it searched.
 *
 * The tokenizer has one of its own, which no tree adapter sees: it keeps a tag's
 * attributes in a list and searches that list for a duplicate before adding each
 * new one, so one `<div a0 a1 a2 …>` costs the square of its attribute count —
 * measured here, 50,000 attributes (246 KiB) took 4.3s and 200,000 (1.1 MiB)
 * 66s. Each of those searches is charged as many steps as the list is long, by
 * {@link MeteredTokenizer}. Re-adding attributes to `<html>` or `<body>` from a
 * repeated tag is the same search at tree level, charged by {@link ADOPT_WEIGHT}.
 * Charging the work rather than capping attributes per tag leaves real markup
 * alone: an element with a few dozen attributes, the most any framework or SVG
 * writes, costs a few hundred steps, and the budget allows a single tag about
 * seven thousand. Every other shape the tokenizer reads — long values, names,
 * comments, doctypes, character references, CDATA, raw text — was timed at two
 * mebibytes and is linear.
 *
 * Counting steps rather than time keeps the verdict the same on every machine.
 * Measured here, a two-mebibyte page of ordinary markup takes about four million
 * steps, and the same page wrapped two hundred levels deep about sixteen
 * million; at this budget a hostile page is refused in a fraction of a second.
 */
const MAX_PARSE_STEPS = 24_000_000;

/**
 * Steps charged per attribute when `<html>` or `<body>` adopts a repeated tag's.
 *
 * The adapter builds a set of the element's names each time, which costs about
 * sixteen times what one comparison does: charged one step each, a page of
 * `<body a0><body a1>…` used the whole budget and still took 0.85s to refuse.
 * A real page does this once or twice, if at all.
 */
const ADOPT_WEIGHT = 16;

/** Thrown out of the parser to stop it, the moment a document is known to be too deep or too costly. */
class TooDeep extends Error {}

/**
 * parse5's tokenizer, charging each attribute's duplicate search to the parse.
 *
 * A subclass because the search happens in a protected method and nothing else
 * observes it: the tokenizer reports a tag only once all its attributes are
 * read, which is after the quadratic work is done.
 */
class MeteredTokenizer extends Tokenizer {
  readonly #spend: (cost: number) => void;

  constructor(options: TokenizerOptions, handler: TokenHandler, spend: (cost: number) => void) {
    super(options, handler);
    this.#spend = spend;
  }

  protected override _leaveAttrName(): void {
    const token = this.currentToken;
    if (token !== null && 'attrs' in token) this.#spend(token.attrs.length);
    super._leaveAttrName();
  }
}

/**
 * parse5's parser with {@link MeteredTokenizer} in place of its own.
 *
 * `Parser` is the class `parse()` itself runs. parse5 exports it but marks it
 * internal, so an upgrade could change how it builds its tokenizer; the
 * hostile-attribute tests in `test/lib/html.test.ts` hang rather than pass if
 * tokens ever stop going through the replacement.
 */
class MeteredParser extends Parser<DefaultTreeAdapterMap> {
  constructor(options: ParserOptions<DefaultTreeAdapterMap>, spend: (cost: number) => void) {
    super(options);
    this.tokenizer = new MeteredTokenizer(this.options, this, spend);
  }
}

/**
 * Parses a document, giving up as soon as it nests too deeply.
 *
 * Measured inside the parser rather than by scanning the text, because scanning
 * means predicting the parser, and every prediction is a way past the guard:
 * `<div '>`, `<!-->` and `<svg><title>` are all read differently by a scanner than
 * by the HTML standard's algorithm.
 *
 * Two measures, because neither is enough alone. The parser's stack of open
 * elements is what its cost grows with — every start tag walks it — so the parse
 * stops the moment that stack passes the limit. But the tree is not the stack:
 * the adoption agency algorithm and foster parenting move whole subtrees, so a
 * depth recorded when a node was attached goes stale, and
 * `<dd><li><nobr></div><em>` repeated built a tree thousands of levels deep while
 * a per-attach count saw only a handful. The finished tree is therefore measured
 * once more, by a walk that is linear in its size. A shallow stack can still be
 * walked too often, so the work is counted too: see {@link MAX_PARSE_STEPS}.
 *
 * @param html The document as served.
 * @param limit Levels to allow.
 * @returns The tree, or `null` when the document nests deeper than the limit.
 * @throws Never.
 */
function parseWithinDepth(html: string, limit: number): DefaultTreeAdapterTypes.Document | null {
  let open = 0;
  let steps = 0;
  const spend = (cost: number): void => {
    steps += cost;
    if (steps > MAX_PARSE_STEPS) throw new TooDeep();
  };
  // Searched from the end, where the parser nearly always works: foster
  // parenting inserts before the table it just opened, which is its parent's
  // last child. parse5's own adapter searches from the start, so thousands of
  // sloppy tables side by side cost the square of their number for no reason.
  // What is charged is what is done — the distance searched, which is also
  // what the splice shifts — so a hostile page that does make the parser work
  // far from the end still runs out of budget.
  const positionOf = (siblings: Node[], node: Node): number => {
    const index = siblings.lastIndexOf(node);
    spend(siblings.length - index);
    return index;
  };
  const treeAdapter: typeof defaultTreeAdapter = {
    ...defaultTreeAdapter,
    getNamespaceURI: (element) => {
      spend(1);
      return defaultTreeAdapter.getNamespaceURI(element);
    },
    insertBefore: (parent, child, reference) => {
      const index = positionOf(parent.childNodes, reference);
      parent.childNodes.splice(index, 0, child);
      child.parentNode = parent;
    },
    insertTextBefore: (parent, text, reference) => {
      const index = positionOf(parent.childNodes, reference);
      const previous = index > 0 ? parent.childNodes[index - 1] : undefined;
      if (previous !== undefined && defaultTreeAdapter.isTextNode(previous)) {
        previous.value += text;
        return;
      }
      parent.childNodes.splice(index, 0, defaultTreeAdapter.createTextNode(text));
      const inserted = parent.childNodes[index];
      if (inserted !== undefined) inserted.parentNode = parent;
    },
    adoptAttributes: (recipient, attrs) => {
      spend(ADOPT_WEIGHT * (recipient.attrs.length + attrs.length));
      defaultTreeAdapter.adoptAttributes(recipient, attrs);
    },
    detachNode: (node) => {
      const parent = node.parentNode;
      if (parent === null) return;
      parent.childNodes.splice(positionOf(parent.childNodes, node), 1);
      node.parentNode = null;
    },
    onItemPush: () => {
      open += 1;
      if (open > limit) throw new TooDeep();
    },
    onItemPop: () => {
      open -= 1;
    },
  };

  let document: DefaultTreeAdapterTypes.Document;
  try {
    const parser = new MeteredParser({ treeAdapter }, spend);
    parser.tokenizer.write(html, true);
    document = parser.document;
  } catch (cause) {
    if (cause instanceof TooDeep) return null;
    throw cause;
  }
  return deeperThan(document, limit) ? null : document;
}

/**
 * @param root A parsed document.
 * @param limit Levels to allow.
 * @returns Whether any node, template content included, sits deeper than the limit.
 * @throws Never.
 */
function deeperThan(root: Node, limit: number): boolean {
  const stack: [Node, number][] = [[root, 0]];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) continue;
    const [node, depth] = entry;
    if (depth > limit) return true;
    for (const child of 'childNodes' in node ? node.childNodes : []) stack.push([child, depth + 1]);
    if (isElement(node) && node.tagName === 'template' && 'content' in node) {
      stack.push([node.content, depth + 1]);
    }
  }
  return false;
}

/**
 * Whether a document is nested too deeply to be worth reading.
 *
 * @param html The document as served.
 * @param limit Levels to allow. Defaults to {@link MAX_NESTING_DEPTH}.
 * @returns `true` when the document nests deeper than the limit.
 * @throws Never.
 */
export function nestsTooDeeply(html: string, limit: number = MAX_NESTING_DEPTH): boolean {
  return parseWithinDepth(html, limit) === null;
}

/**
 * Reads a page, unless it nests too deeply to be worth reading.
 *
 * What a tool should call. Asking {@link nestsTooDeeply} and then
 * {@link extractPage} parses a document twice on the event loop.
 *
 * @param html The document as served.
 * @param baseUrl The URL it was fetched from.
 * @returns The extracted facts, or `null` when the document was refused.
 * @throws Never.
 */
export function readPage(html: string, baseUrl: string): PageContent | null {
  const document = parseWithinDepth(html, MAX_NESTING_DEPTH);
  return document === null ? null : contentOf(document, baseUrl);
}

/**
 * Extracts everything a technical SEO check reads from one page.
 *
 * @param html The document as served.
 * @param baseUrl The URL it was fetched from, used to resolve relative links.
 *   A `<base href>` in the document overrides it, exactly as it would in a
 *   browser.
 * @returns The extracted facts. Absent things are `null` or empty, never
 *   guessed.
 * @throws Never — a document too broken to yield anything comes back empty.
 */
export function extractPage(html: string, baseUrl: string): PageContent {
  return contentOf(parse(html), baseUrl);
}

/**
 * @param document A parsed document.
 * @param baseUrl The URL it was fetched from.
 * @returns What {@link extractPage} promises.
 * @throws Never.
 */
function contentOf(document: DefaultTreeAdapterTypes.Document, baseUrl: string): PageContent {
  const elements = collectElements(document);

  const base = resolveBase(elements, baseUrl);
  const htmlElement = elements.find((element) => element.tagName === 'html');
  const openGraph: Record<string, string> = {};
  const headings: Heading[] = [];
  const images: PageImage[] = [];
  const links: PageLink[] = [];
  const alternates: AlternateLink[] = [];

  let title: string | null = null;
  let metaDescription: string | null = null;
  let metaRobots: string | null = null;
  let canonical: string | null = null;
  let hasViewport = false;

  for (const element of elements) {
    switch (element.tagName) {
      case 'title': {
        title ??= textOf(element) || null;
        break;
      }
      case 'meta': {
        const name = attribute(element, 'name')?.toLowerCase();
        const property = attribute(element, 'property')?.toLowerCase();
        const content = attribute(element, 'content');
        if (content === null) break;
        if (name === 'description') metaDescription ??= collapse(content) || null;
        if (name === 'robots') metaRobots ??= collapse(content).toLowerCase() || null;
        if (name === 'viewport') hasViewport = true;
        if (property?.startsWith('og:') === true) {
          openGraph[property.slice(3)] ??= collapse(content);
        }
        break;
      }
      case 'link': {
        const rel = attribute(element, 'rel')?.toLowerCase() ?? '';
        const href = resolve(attribute(element, 'href'), base);
        if (href === null) break;
        if (rel.split(/\s+/).includes('canonical')) canonical ??= href;
        if (rel.split(/\s+/).includes('alternate')) {
          const hreflang = attribute(element, 'hreflang');
          if (hreflang !== null) alternates.push({ hreflang, href });
        }
        break;
      }
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        headings.push({ level: Number(element.tagName.slice(1)), text: textOf(element) });
        break;
      }
      case 'img': {
        images.push({
          src: resolve(attribute(element, 'src'), base),
          alt: attribute(element, 'alt'),
        });
        break;
      }
      case 'a': {
        const href = resolve(attribute(element, 'href'), base);
        // Only what can be requested. `mailto:`, `tel:` and `javascript:` are
        // links a reader can follow and a link checker cannot.
        if (href === null || !href.startsWith('http')) break;
        links.push({
          href,
          rel: attribute(element, 'rel')?.toLowerCase() ?? null,
          text: textOf(element),
        });
        break;
      }
      default:
        break;
    }
  }

  return {
    title,
    metaDescription,
    metaRobots,
    canonical,
    lang: htmlElement === undefined ? null : (attribute(htmlElement, 'lang') ?? null),
    hasViewport,
    openGraph,
    headings,
    images,
    links,
    alternates,
  };
}

/**
 * Flattens the tree into every element, in document order.
 *
 * `<template>` contents are skipped: they are inert until a script clones them,
 * so counting a heading or an image inside one would report markup no visitor
 * has ever seen.
 *
 * @param root The parsed document.
 * @returns Every element, outermost first.
 * @throws Never.
 */
function collectElements(root: Node): Element[] {
  const found: Element[] = [];
  const stack: Node[] = [root];

  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) continue;
    if (isElement(node)) {
      found.push(node);
      if (node.tagName === 'template') continue;
    }
    const children = 'childNodes' in node ? node.childNodes : [];
    // Pushed in reverse so that popping walks the children left to right, which
    // is what makes "document order" true of the result.
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) stack.push(child);
    }
  }

  return found;
}

/**
 * The URL relative links resolve against.
 *
 * @param elements Every element in the document.
 * @param fallback The URL the page was fetched from.
 * @returns The first usable `<base href>`, or the fallback.
 * @throws Never.
 */
function resolveBase(elements: readonly Element[], fallback: string): string {
  for (const element of elements) {
    if (element.tagName !== 'base') continue;
    const href = resolve(attribute(element, 'href'), fallback);
    if (href !== null) return href;
  }
  return fallback;
}

/**
 * @param node Any node.
 * @returns Whether it is an element, narrowing the type.
 * @throws Never.
 */
function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

/**
 * @param element The element to read.
 * @param name Attribute name, lowercase.
 * @returns The attribute value, or `null` when it is not present. An attribute
 *   written without a value reads as an empty string, which is how `alt=""`
 *   stays distinguishable from a missing `alt`.
 * @throws Never.
 */
function attribute(element: Element, name: string): string | null {
  return element.attrs.find((candidate) => candidate.name === name)?.value ?? null;
}

/**
 * @param element The element whose text is wanted.
 * @returns Its descendant text with whitespace collapsed, skipping anything a
 *   reader never sees.
 * @throws Never.
 */
function textOf(element: Element): string {
  const parts: string[] = [];
  const stack: Node[] = [element];

  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) continue;
    if (isElement(node) && NON_RENDERED.has(node.tagName)) continue;
    if (node.nodeName === '#text' && 'value' in node) parts.push(node.value);
    const children = 'childNodes' in node ? node.childNodes : [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) stack.push(child);
    }
  }

  return collapse(parts.join(' '));
}

/**
 * @param value Any text from the document.
 * @returns The same text with runs of whitespace reduced to one space and the
 *   ends trimmed, so that a heading broken across three source lines compares
 *   as the one string a reader sees.
 * @throws Never.
 */
function collapse(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * @param href An attribute value, possibly relative, possibly absent.
 * @param base The URL to resolve against.
 * @returns An absolute URL, or `null` when there is nothing usable to resolve.
 * @throws Never.
 */
function resolve(href: string | null, base: string): string | null {
  if (href === null || href.trim() === '') return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}
