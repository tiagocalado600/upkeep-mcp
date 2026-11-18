import { describe, expect, it } from 'vitest';
import { extractPage, readPage } from '../../src/lib/html.js';

const BASE = 'https://example.com/blog/post';

describe('extractPage', () => {
  it('reads the metadata a technical check reports on', () => {
    const page = extractPage(
      `<!doctype html>
       <html lang="pt-PT">
         <head>
           <title>  A   page   title </title>
           <meta name="description" content="What the page is about.">
           <meta name="robots" content="INDEX, FOLLOW">
           <meta name="viewport" content="width=device-width">
           <link rel="canonical" href="/blog/post">
           <meta property="og:title" content="Shared title">
           <meta property="og:image" content="https://cdn.example.com/card.png">
         </head>
         <body><h1>Heading</h1></body>
       </html>`,
      BASE,
    );

    expect(page.title).toBe('A page title');
    expect(page.metaDescription).toBe('What the page is about.');
    expect(page.metaRobots).toBe('index, follow');
    expect(page.hasViewport).toBe(true);
    expect(page.lang).toBe('pt-PT');
    expect(page.canonical).toBe('https://example.com/blog/post');
    expect(page.openGraph).toEqual({
      title: 'Shared title',
      image: 'https://cdn.example.com/card.png',
    });
  });

  it('distinguishes a missing alt from a deliberately empty one', () => {
    const page = extractPage(
      `<img src="/a.png" alt="A cat">
       <img src="/b.png" alt="">
       <img src="/c.png">`,
      BASE,
    );

    expect(page.images).toEqual([
      { src: 'https://example.com/a.png', alt: 'A cat' },
      { src: 'https://example.com/b.png', alt: '' },
      { src: 'https://example.com/c.png', alt: null },
    ]);
  });

  it('keeps headings in document order with their level', () => {
    const page = extractPage(
      `<h1>One</h1><section><h3>Three</h3></section><h2>Two <em>emphasised</em></h2>`,
      BASE,
    );

    expect(page.headings).toEqual([
      { level: 1, text: 'One' },
      { level: 3, text: 'Three' },
      { level: 2, text: 'Two emphasised' },
    ]);
  });

  it('resolves links and drops the ones a checker cannot request', () => {
    const page = extractPage(
      `<a href="/about">About</a>
       <a href="../index.html">Up</a>
       <a href="https://other.example/x" rel="NOFOLLOW">Away</a>
       <a href="mailto:someone@example.com">Mail</a>
       <a href="tel:+351210000000">Call</a>
       <a href="javascript:void(0)">Script</a>
       <a>No href</a>`,
      BASE,
    );

    expect(page.links).toEqual([
      { href: 'https://example.com/about', rel: null, text: 'About' },
      { href: 'https://example.com/index.html', rel: null, text: 'Up' },
      { href: 'https://other.example/x', rel: 'nofollow', text: 'Away' },
    ]);
  });

  it('honours a base href, as a browser would', () => {
    const page = extractPage(
      `<head><base href="https://cdn.example.com/v2/"></head><body><a href="page">P</a></body>`,
      BASE,
    );

    expect(page.links[0]?.href).toBe('https://cdn.example.com/v2/page');
  });

  it('collects hreflang alternates', () => {
    const page = extractPage(
      `<link rel="alternate" hreflang="en" href="/en/post">
       <link rel="alternate" hreflang="x-default" href="/post">
       <link rel="alternate" type="application/rss+xml" href="/feed">`,
      BASE,
    );

    expect(page.alternates).toEqual([
      { hreflang: 'en', href: 'https://example.com/en/post' },
      { hreflang: 'x-default', href: 'https://example.com/post' },
    ]);
  });

  it('ignores markup inside a template, which no visitor has seen', () => {
    const page = extractPage(
      `<h1>Real</h1><template><h1>Cloned later</h1><img src="/x.png"></template>`,
      BASE,
    );

    expect(page.headings).toEqual([{ level: 1, text: 'Real' }]);
    expect(page.images).toEqual([]);
  });

  it('keeps script and style text out of the text it reports', () => {
    const page = extractPage(
      `<h1>Title<script>var x = "noise";</script><style>h1{}</style></h1>`,
      BASE,
    );

    expect(page.headings).toEqual([{ level: 1, text: 'Title' }]);
  });

  it('reads a document a browser would fix up, not one it would reject', () => {
    // Unclosed <p>, metadata after the body has started, a stray close tag:
    // exactly what a real site serves.
    const page = extractPage(`<html><body><p>text<h1>Heading</div><img src=/a.png alt=Cat>`, BASE);

    expect(page.headings).toEqual([{ level: 1, text: 'Heading' }]);
    expect(page.images).toEqual([{ src: 'https://example.com/a.png', alt: 'Cat' }]);
  });

  it('comes back empty rather than throwing on a document with nothing in it', () => {
    const page = extractPage('', BASE);

    expect(page.title).toBeNull();
    expect(page.canonical).toBeNull();
    expect(page.headings).toEqual([]);
    expect(page.openGraph).toEqual({});
  });

  it('takes the first title and canonical when a page carries two', () => {
    const page = extractPage(
      `<title>First</title><title>Second</title>
       <link rel="canonical" href="/one"><link rel="canonical" href="/two">`,
      BASE,
    );

    expect(page.title).toBe('First');
    expect(page.canonical).toBe('https://example.com/one');
  });
});

describe('readPage', () => {
  const MIB = 1024 * 1024;
  const repeatTo = (prefix: string, unit: string, bytes: number): string =>
    prefix + unit.repeat(Math.ceil((bytes - prefix.length) / unit.length));
  const timed = (html: string): { refused: boolean; ms: number } => {
    const startedAt = performance.now();
    const refused = readPage(html, BASE) === null;
    return { refused, ms: performance.now() - startedAt };
  };

  it.each([
    '<dd><li><nobr></div><em>',
    '<font><div></a><a>',
    '<a><td><font><div><b>',
    '<dd><blockquote><a></p><em>',
    '</p><template>',
  ])('refuses misnesting that the parser reparents into a deep tree: %s', (unit) => {
    // The adoption agency algorithm moves whole subtrees, so a depth noted when
    // each element was attached goes stale and the real tree outgrows the limit.
    const { refused, ms } = timed(repeatTo('<html><body>', unit, 256 * 1024));

    expect(refused).toBe(true);
    expect(ms).toBeLessThan(1000);
  });

  it.each([
    ['list items', '<li>'],
    ['definition terms', '<dd>'],
    ['headings', '<h1>'],
    ['stray list closers', '</li>'],
    ['stray heading closers', '</h1>'],
    ['reopened blocks', '</div><div>'],
  ])('refuses two mebibytes that walk a deep stack on every tag: %s', (_label, unit) => {
    // Within the depth limit, and still seconds of blocked event loop before
    // the parser's work was counted.
    const { refused, ms } = timed(repeatTo(`<html><body>${'<div>'.repeat(500)}`, unit, 2 * MIB));

    expect(refused).toBe(true);
    expect(ms).toBeLessThan(2000);
  });

  it.each([
    ['foreign content', '<table><math>'],
    ['blocks', '<table><div><dd>'],
    ['formatting', '<table><em><ruby>'],
  ])('finishes two mebibytes that foster-parent into a long sibling list: %s', (_label, unit) => {
    // Each insertion before a `<table>` searches its parent's children for it.
    // Searched from the start, as parse5 does, the parse grew with the square of
    // the sibling count and took seventeen seconds; searched from the end, where
    // the table is, it is linear, and the page is simply read.
    const { ms } = timed(repeatTo(`<html><body>${'<span>'.repeat(500)}`, unit, 2 * MIB));

    expect(ms).toBeLessThan(2000);
  });

  /** Repeats `unit(0)`, `unit(1)`, … until the document reaches `bytes`. */
  const numbered = (prefix: string, unit: (n: string) => string, suffix: string, bytes: number) => {
    const parts = [prefix];
    let length = prefix.length + suffix.length;
    for (let n = 0; length < bytes; n += 1) {
      const part = unit(n.toString(36));
      parts.push(part);
      length += part.length;
    }
    return parts.join('') + suffix;
  };

  it.each([
    ['separated by spaces', '<div', (n: string) => ` a${n}`, '>'],
    ['separated by slashes', '<div ', (n: string) => `a${n}/`, '>'],
    ['after quoted values, with no space', '<div ', (n: string) => `a${n}=""`, '>'],
    ['on a closing tag', '</div', (n: string) => ` a${n}`, '>'],
    ['on foreign content', '<svg', (n: string) => ` a${n}`, '>'],
  ])('refuses two mebibytes of attributes on one tag: %s', (_label, prefix, unit, suffix) => {
    // The tokenizer searches a tag's attributes for a duplicate before adding
    // each one, and no tree adapter sees it: 200,000 of them blocked the event
    // loop for over a minute.
    const { refused, ms } = timed(numbered(prefix, unit, suffix, 2 * MIB));

    expect(refused).toBe(true);
    expect(ms).toBeLessThan(1000);
  });

  it.each([
    ['<body>', (n: string) => `<body a${n}>`],
    ['<html>', (n: string) => `<html a${n}>`],
  ])('refuses two mebibytes of repeated %s tags, each adding an attribute', (tag, unit) => {
    // Each repeat copies its new attributes onto the one element, checking the
    // ones it already has: the same quadratic search, at tree level.
    const { refused, ms } = timed(numbered(tag, unit, '', 2 * MIB));

    expect(refused).toBe(true);
    expect(ms).toBeLessThan(1000);
  });

  it.each([
    ['one long attribute value', '<div a="', 'x', '">'],
    ['one long unquoted value', '<div a=', 'x', '>'],
    ['one long attribute name', '<div a', 'x', '>'],
    ['one long tag name', '<a', 'x', '>'],
    ['one repeated attribute', '<div', ' a', '>'],
    ['one long comment', '<!--', 'x', '-->'],
    ['a comment of dashes', '<!--', '-', '>'],
    ['a comment of --!', '<!--', '--!', '-->'],
    ['one long doctype', '<!DOCTYPE ', 'x', '>'],
    ['a long public identifier', '<!DOCTYPE html PUBLIC "', 'x', '">'],
    ['repeated doctypes', '', '<!DOCTYPE html>', ''],
    ['character references', '', '&amp;', ''],
    ['unterminated references', '', '&am', ''],
    ['one long reference name', '&', 'a', ''],
    ['one long numeric reference', '&#', '0', ';'],
    ['references in an attribute', '<div a="', '&notin', '">'],
    ['one long CDATA section', '<svg><![CDATA[', ']', '>'],
    ['false script end tags', '<script>', '</scrip', '</script>'],
    ['escaped script text', '<script>', '<!--<script>', '</script>'],
    ['false textarea end tags', '<textarea>', '</textare', '</textarea>'],
    ['bare less-than signs', '', '<', ''],
    ['bogus comments', '', '<?x', ''],
    ['NUL characters', '', '\0', ''],
  ])('reads or refuses two mebibytes of %s quickly', (_label, prefix, unit, suffix) => {
    // Every other shape the tokenizer reads, each measured at the largest size a
    // page is read to: all of them are linear, and these keep them so.
    const { ms } = timed(repeatTo(prefix, unit, 2 * MIB) + suffix);

    expect(ms).toBeLessThan(1000);
  });

  it('still reads elements with as many attributes as real markup carries', () => {
    // A framework-heavy element, and an SVG drawn by a design tool.
    const element = `<button ${Array.from({ length: 200 }, (_, n) => `data-x${String(n)}="v"`).join(' ')}>Go</button>`;
    const path =
      '<path d="M0 0L10 10" fill="#000" stroke="#fff" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity=".5" transform="translate(1 1)" class="p" data-name="x"/>';
    const html = repeatTo(`<!doctype html><html><body>${element}<svg>`, path, 2 * MIB);

    expect(readPage(html, BASE)).not.toBeNull();
  });

  it.each([
    ['a stray &nbsp; in each table', '<table>&nbsp;<tr><td>a</td></tr></table>\n'],
    ['a stray element in each table', '<table><tr><td>a</td></tr><span>stray</span></table>\n'],
    [
      'a form wrapping each table row',
      '<table><form><tr><td><input name=x></td></tr></form></table>\n',
    ],
  ])('still reads thousands of sloppy tables side by side: %s', (_label, unit) => {
    // Each stray piece is moved out in front of its own table, which is the
    // last child of their shared parent. Charged the length of that parent's
    // child list, 6,000 of these in one <div> used to be refused in 13ms.
    const html = `<!doctype html><html><body><div>${unit.repeat(6000)}</div>`;

    expect(readPage(html, BASE)).not.toBeNull();
  });

  it('still reads a large page of ordinary, sloppy markup', () => {
    const unit =
      '<div class=row><ul><li><a href="/x">text<li><span><b>t</span></b><p>text <em>e <strong>s</em></strong><p>more<table><tr><td>a<td>b</tr><span>stray</span></table><font><center>x</font></center></div>\n';
    const html = repeatTo(`<!doctype html><html><body>${'<div>'.repeat(30)}`, unit, 2 * MIB);

    expect(readPage(html, BASE)).not.toBeNull();
  });
});
