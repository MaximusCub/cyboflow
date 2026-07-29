/**
 * designInspectorScript — the app-owned inspector that runs inside the design
 * COMMENT frame (design-mode.md "Comment mode — live-DOM freeze + sanitizer +
 * nonce-CSP").
 *
 * The comment frame renders a sanitized freeze of the live prototype DOM under
 * a nonce-only `script-src`. This script is the ONLY thing in that document
 * carrying the nonce, so it is the frame's sole possible writer: even if the
 * sanitizer missed a vector, an inline `onclick` or a `javascript:` URL cannot
 * execute (the CSP is the enforcement; the sanitizer is defense in depth; the
 * navigation guard covers what CSP cannot govern — document navigation).
 *
 * It therefore may not do anything the trust story doesn't require: NO eval, NO
 * `new Function`, NO dynamic `<script>` creation, NO network. It reads the
 * frozen DOM, paints ONE overlay box it owns (never mutating the captured DOM's
 * layout — that would change what the user is commenting on), and posts element
 * stacks to the parent. Inspector output is UI input (anchoring), never a
 * security decision, so the parent still validates the message shape.
 *
 * Kept as a template string rather than a bundled asset because it is injected
 * server-side into stored bytes: the nonce is minted per capture, so the tag
 * must be rendered per capture too (see {@link renderDesignInspectorScriptTag}).
 */

/** Replaced with the capture's freshly-minted CSP nonce at injection time. */
export const DESIGN_INSPECTOR_NONCE_PLACEHOLDER = '__CYBOFLOW_INSPECTOR_NONCE__';

/** The message `type` the inspector posts to the parent for hover/pick events. */
export const DESIGN_INSPECT_MESSAGE_TYPE = 'cyboflow-design-inspect';

/**
 * The inspector `<script>` tag, nonce un-substituted. ES5-flavoured and free of
 * template literals so it can be embedded verbatim in a document without any
 * escaping ambiguity.
 */
export const DESIGN_INSPECTOR_SCRIPT_TEMPLATE = `<script nonce="${DESIGN_INSPECTOR_NONCE_PLACEHOLDER}">
(function () {
  var OVERLAY_ID = '__cyboflow_inspect_overlay__';
  var MESSAGE_TYPE = '${DESIGN_INSPECT_MESSAGE_TYPE}';
  var THROTTLE_MS = 50;
  var LABEL_MAX = 40;
  var lastMoveAt = 0;
  var overlay = null;

  /* The single highlight box this script owns. Appended to <body> lazily (the
     tag is hoisted into <head>, so <body> may not exist yet) and pointer-events
     none so it never intercepts elementFromPoint or a click. */
  function getOverlay() {
    if (overlay && overlay.isConnected) return overlay;
    if (!document.body) return null;
    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.setAttribute('data-cyboflow-inspector', 'overlay');
    var s = overlay.style;
    s.position = 'fixed';
    s.top = '0px';
    s.left = '0px';
    s.width = '0px';
    s.height = '0px';
    s.display = 'none';
    s.boxSizing = 'border-box';
    s.margin = '0';
    s.padding = '0';
    s.pointerEvents = 'none';
    s.zIndex = '2147483647';
    s.border = '2px solid #3b82f6';
    s.background = 'rgba(59, 130, 246, 0.12)';
    s.borderRadius = '2px';
    document.body.appendChild(overlay);
    return overlay;
  }

  function hideOverlay() {
    if (overlay) overlay.style.display = 'none';
  }

  function highlight(el) {
    var box = getOverlay();
    if (!box || !el || typeof el.getBoundingClientRect !== 'function') return;
    var rect = el.getBoundingClientRect();
    box.style.top = rect.top + 'px';
    box.style.left = rect.left + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';
    box.style.display = 'block';
  }

  function isOverlay(el) {
    return !!el && (el === overlay || el.id === OVERLAY_ID);
  }

  function labelFor(el) {
    var text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text) return text.slice(0, LABEL_MAX);
    var aria = typeof el.getAttribute === 'function' ? el.getAttribute('aria-label') : null;
    if (aria) {
      var trimmed = aria.replace(/\\s+/g, ' ').trim();
      if (trimmed) return trimmed.slice(0, LABEL_MAX);
    }
    return null;
  }

  /* Innermost-first ancestor stack, target .. <body> inclusive. The overlay is
     skipped so the app's own chrome never appears in an anchor. */
  function stackFrom(el) {
    var stack = [];
    var node = el;
    while (node && node.nodeType === 1) {
      if (isOverlay(node)) {
        node = node.parentElement;
        continue;
      }
      var tag = String(node.localName || node.tagName || '').toLowerCase();
      stack.push({
        tag: tag,
        designId: typeof node.getAttribute === 'function' ? node.getAttribute('data-design-id') : null,
        label: labelFor(node)
      });
      if (tag === 'body') break;
      node = node.parentElement;
    }
    return stack;
  }

  function post(kind, stack) {
    try {
      parent.postMessage({ type: MESSAGE_TYPE, kind: kind, stack: stack }, '*');
    } catch (err) {
      /* a dead / detached parent must never wedge the inspector */
    }
  }

  function elementAt(event) {
    var el = document.elementFromPoint(event.clientX, event.clientY);
    if (isOverlay(el)) return null;
    return el;
  }

  document.addEventListener('pointermove', function (event) {
    var now = Date.now();
    if (now - lastMoveAt < THROTTLE_MS) return;
    lastMoveAt = now;
    try {
      var el = elementAt(event);
      if (!el) {
        hideOverlay();
        return;
      }
      highlight(el);
      post('hover', stackFrom(el));
    } catch (err) {
      /* never let a hostile getter break hovering */
    }
  }, true);

  document.addEventListener('click', function (event) {
    event.preventDefault();
    event.stopPropagation();
    try {
      var target = event.target && event.target.nodeType === 1 ? event.target : null;
      var el = isOverlay(target) || !target ? elementAt(event) : target;
      if (el) post('pick', stackFrom(el));
    } catch (err) {
      /* swallow — the click default action is already cancelled */
    }
  }, true);

  /* Belt to the navigation guard's suspenders: a captured <form> or a keyboard
     activation must not attempt a navigation in the first place. */
  document.addEventListener('submit', function (event) {
    event.preventDefault();
    event.stopPropagation();
  }, true);

  document.addEventListener('keydown', function (event) {
    event.preventDefault();
  }, true);
})();
</script>`;

/**
 * Render the inspector tag carrying `nonce`. The nonce is minted by the caller
 * (`randomBytes` hex) and must match the `script-src 'nonce-…'` in the response
 * header exactly — a mismatch means the inspector silently doesn't run and the
 * comment frame is inert.
 */
export function renderDesignInspectorScriptTag(nonce: string): string {
  return DESIGN_INSPECTOR_SCRIPT_TEMPLATE.split(DESIGN_INSPECTOR_NONCE_PLACEHOLDER).join(nonce);
}
