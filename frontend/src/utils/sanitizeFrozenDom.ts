/**
 * sanitizeFrozenDom — parent-side sanitization of a frozen prototype DOM
 * (design-mode.md "Comment mode — live-DOM freeze + sanitizer + nonce-CSP").
 *
 * Entering comment mode captures a serialization of the LIVE rendered DOM from
 * the interactive prototype frame. Those bytes come out of an untrusted frame,
 * so they are treated as untrusted CONTENT: sanitized here, then re-hosted under
 * a nonce-only `script-src` where the app-owned inspector is the only script
 * that can execute.
 *
 * DEFENSE IN DEPTH, NOT THE ENFORCEMENT. Under the comment frame's CSP an inline
 * handler or a `javascript:` URL cannot execute even if this function misses a
 * vector, and the artifact-frame navigation guard blocks the document navigation
 * CSP does not govern. This pass exists so a miss in either of those is not a
 * single point of failure — which is also why it errs toward removing whole
 * classes of element rather than pattern-matching payloads.
 *
 * FIDELITY MATTERS AS MUCH AS SAFETY. The user is commenting on what they saw,
 * so everything that carries appearance survives verbatim: inline `<style>`,
 * `style=""` attributes, `data:` images, and all ordinary markup and text. Where
 * an element is only PARTLY dangerous (a `<form>`, a `<button formaction>`) the
 * element is kept and the offending attribute removed, so layout is unchanged.
 *
 * DOMParser-based and pure — no DOM mutation outside the parsed document, no
 * reliance on the live document, so it unit-tests as a plain string→string
 * function.
 */

/**
 * Elements removed outright (subtree included). Two groups:
 *   - execution vectors: `<script>` (HTML *and* SVG — matched by local name, so
 *     `<svg><script>` is caught too), `<object>`, `<embed>`;
 *   - navigation / nested-browsing-context vectors: frames of every flavour,
 *     plus `<base>` (retargets every relative URL in the document).
 * `<link>` goes because it is a subresource fetch (stylesheet, prefetch,
 * ping-adjacent) whose bytes we do not control; inline `<style>` is the
 * fidelity-preserving substitute and is kept.
 * `<template>` goes because its content is a separate DocumentFragment the
 * tree walk below never visits — a `<script>` hiding inside one would survive
 * the sweep (inert under the nonce CSP, but this pass must not depend on that).
 * Removing it is fidelity-neutral: template content never renders.
 */
const FORBIDDEN_TAGS: ReadonlySet<string> = new Set([
  'script',
  'object',
  'embed',
  'iframe',
  'frame',
  'frameset',
  'portal',
  'base',
  'link',
  'template',
]);

/**
 * Attributes carrying a URL that must be scheme-checked. `xlink:href` is the SVG
 * legacy form and is still honoured by browsers, so it is checked by qualified
 * name alongside the modern `href`.
 */
const URL_ATTRIBUTES: readonly string[] = ['href', 'src', 'action', 'formaction', 'xlink:href'];

/**
 * Attributes removed unconditionally wherever they appear — submission targets.
 * `<form action>` and `<button|input formaction>` are navigation-capable no
 * matter how benign the value looks, and the frozen capture is not interactive
 * in any sense that needs them. The ELEMENTS are kept so layout is untouched.
 */
const SUBMISSION_ATTRIBUTES: readonly string[] = ['action', 'formaction'];

/** Schemes that execute script when navigated to. */
const DANGEROUS_SCHEMES: readonly string[] = ['javascript:', 'vbscript:'];

/**
 * Whether a URL value resolves to a script-executing scheme.
 *
 * Browsers strip ASCII whitespace and C0 control characters from a URL ANYWHERE,
 * so `java\tscript:alert(1)` and `\n javascript:…` both navigate to the script
 * scheme. Dropping every code unit at or below U+0020 before the prefix test is
 * what makes this match browser behaviour rather than the literal attribute text.
 * A benign URL containing a space (`my page.html`) is unaffected — it still does
 * not start with a dangerous scheme once the space is dropped.
 *
 * Written as a scan rather than a character-class regex because such a class must
 * contain literal control characters (lint: no-control-regex).
 */
function hasDangerousScheme(value: string): boolean {
  let collapsed = '';
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0x20) collapsed += value[i];
  }
  const lowered = collapsed.toLowerCase();
  return DANGEROUS_SCHEMES.some((scheme) => lowered.startsWith(scheme));
}

/** Strip the attributes that make an element active. The element itself stays. */
function sanitizeAttributes(el: Element): void {
  // Snapshot the names — removal mutates the live attribute list.
  for (const name of [...el.getAttributeNames()]) {
    const lowered = name.toLowerCase();

    // Every `on*` attribute is an event handler; there is no benign one.
    if (lowered.startsWith('on')) {
      el.removeAttribute(name);
      continue;
    }

    if (SUBMISSION_ATTRIBUTES.includes(lowered)) {
      el.removeAttribute(name);
      continue;
    }

    if (URL_ATTRIBUTES.includes(lowered) && hasDangerousScheme(el.getAttribute(name) ?? '')) {
      el.removeAttribute(name);
    }
  }
}

/**
 * Remove `<meta http-equiv>` (the `refresh` navigation vector, and any policy
 * meta the capture might carry — the comment frame's real policy arrives as a
 * response header and must not be second-guessed by captured markup). A plain
 * `<meta charset>` / `<meta name>` is inert and stays.
 */
function isForbiddenMeta(el: Element): boolean {
  return el.localName.toLowerCase() === 'meta' && el.hasAttribute('http-equiv');
}

/**
 * Sanitize a frozen-DOM serialization into a document string safe to host in the
 * comment frame. Input that does not parse as HTML still yields a well-formed
 * document (DOMParser never throws for `text/html`), so a malformed capture
 * degrades to an empty-ish frame rather than an exception.
 */
export function sanitizeFrozenDom(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // Collect first, mutate after: removing during a live-tree walk skips siblings.
  const doomed: Element[] = [];
  const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_ELEMENT);
  const elements: Element[] = [doc.documentElement];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node instanceof Element) elements.push(node);
  }

  for (const el of elements) {
    // `localName` rather than `tagName` so SVG's case-sensitive names (and any
    // foreign-content element) compare on the same footing as HTML's.
    if (FORBIDDEN_TAGS.has(el.localName.toLowerCase()) || isForbiddenMeta(el)) {
      doomed.push(el);
      continue;
    }
    sanitizeAttributes(el);
  }

  for (const el of doomed) el.remove();

  return `<!doctype html>${doc.documentElement.outerHTML}`;
}
