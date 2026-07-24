import { inputsFor, tabsFor, NORMALIZERS } from '@shared/catalog.mjs';

// Carry a finished run's subject FORWARD into the next tool's form.
//
// A "next step" button that dumps the user on an empty form isn't a next step,
// it's homework: they've just read a report about example.com/pricing and the
// tool they land on asks them to type it in again. So we pre-fill — but there
// is no shared field vocabulary across the catalog (`input` is a keyword list on
// Keyword Analysis, a page URL on Page Speed, a topic on Caption Generator), and
// hand-maintaining a per-pair mapping for ~35 tools would rot on the first
// catalog edit.
//
// Instead we read the TARGET tool's own field definitions and fill by field
// SHAPE: a site-ish field gets the site, a keyword-ish field gets the keywords,
// location/language pass straight through. A field we can't classify is left
// alone — an empty field the user fills in beats a confidently wrong one.
//
// Nothing here runs a tool or spends a credit: ToolRunner receives these as
// `location.state.values` (its existing prefill channel, same one the
// Recommendation cards' "Write it in the Content Optimiser" hand-off uses) and
// still waits for the user to press Run.

const str = (v) => (v == null ? '' : String(v).trim());

/** Does this value look like a domain or URL rather than free text? */
const isSite = (v) => {
  const s = str(v);
  return !!s && !/[\s,]/.test(s) && /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+([/?#]|$)/i.test(s);
};
/** A site value with a path — i.e. one specific page, not a whole domain. */
const isPage = (v) => isSite(v) && /^(https?:\/\/)?[^/]+\/[^/\s]/.test(str(v));

const listOf = (v) => (Array.isArray(v) ? v : str(v).split(/[\n,]+/)).map(str).filter(Boolean);

// Field-shape classifiers, applied to the TARGET tool's fields.
//
// The name gate is load-bearing, not belt-and-braces: keying on `type === 'url'`
// alone made the Schema Generator's "Image URL" and "Logo URL" fields look like
// the subject, so a hand-off from any page tool arrived with the page's own
// address pre-filled as its logo — wrong in a way the user has to notice and
// undo. Only a field NAMED for the thing being analysed can hold the subject.
const SITE_NAMES = /^(domain|website|site|url|target|page|pageUrl|input)$/i;
// …and it still has to LOOK like it wants a URL. Some tools take the subject as
// prose ("A website URL, or describe the brand"), so the label/placeholder
// saying "URL" counts too.
const mentionsUrl = (f) => /\burls?\b/i.test(`${f.label || ''} ${f.placeholder || ''}`);
const isSiteField = (f) =>
  SITE_NAMES.test(f.name) &&
  (f.type === 'url' || f.normalize === 'domain' || f.normalize === 'host' || isSite(f.placeholder) || mentionsUrl(f));

// A field holding ONE keyword vs a list of them. Getting this backwards drops
// "seo agency, digital marketing" into a box the tool treats as a single primary
// keyword, and the run silently targets a phrase nobody searches for.
const isKeywordListField = (f) => f.name === 'keywords' || (f.name === 'input' && f.type === 'tags');
const isSingleKeywordField = (f) => f.name === 'keyword' && f.type !== 'tags';

/**
 * Build the prefill for `tool` from the run context we're navigating away from.
 *
 * `context` is ToolRunner's `recContext` shape: { target, domain, inputs }.
 * Returns a plain values object (possibly empty — the caller should still
 * navigate; a partially-filled form is fine).
 */
export function carryValues(tool, context = {}) {
  if (!tool) return {};
  const inp = context.inputs || {};
  const site = str(context.target) || str(context.domain);
  // `input` doubles as the keyword list on keyword-style tools and as a URL
  // elsewhere, so only treat it as keywords when it clearly isn't a site.
  const keywords = listOf(inp.keyword || inp.keywords || (isSite(inp.input) ? '' : inp.input));

  // Tabbed tools (Search Console) open on their first tab; fill against that.
  const tabs = tabsFor(tool);
  const fields = tabs ? (tabs[0]?.fields || []) : inputsFor(tool);

  // When a tool has BOTH a purpose-named site field and a generic `input`, the
  // named one is the subject and `input` is something else entirely — on the
  // Content Optimiser it's the topic for a from-scratch draft, and dropping a
  // URL in there means switching mode reveals a topic box reading
  // "https://example.com/pricing". Let the named field win outright.
  const namedSiteField = fields.some((f) => f.name !== 'input' && isSiteField(f));

  const values = {};
  for (const f of fields) {
    if (values[f.name] != null) continue;   // first matching definition wins
    if (f.name === 'location' && inp.location) { values.location = inp.location; continue; }
    if (f.name === 'language' && inp.language) { values.language = inp.language; continue; }
    if (f.name === 'input' && namedSiteField && !isKeywordListField(f)) continue;

    if (isSiteField(f) && site) {
      // A field that wants a whole site gets one, even if we're holding a page
      // URL — `normalize` would trim it on send anyway, but the user should see
      // what will actually be used before they press Run.
      const norm = NORMALIZERS[f.normalize];
      values[f.name] = norm ? norm(site) : site;
      continue;
    }
    if (isKeywordListField(f) && keywords.length) {
      // `tags` fields hold an array; everything else takes a comma-joined list.
      values[f.name] = f.type === 'tags' ? keywords.slice(0, 10) : keywords.slice(0, 10).join(', ');
      continue;
    }
    if (isSingleKeywordField(f) && keywords.length) {
      values[f.name] = keywords[0];
      continue;
    }
    // A "secondary keywords" companion field takes the rest of the list, so the
    // whole set survives the hop instead of everything after the first being
    // dropped on the floor.
    if (f.name === 'secondary' && keywords.length > 1) {
      values[f.name] = f.type === 'tags' ? keywords.slice(1, 10) : keywords.slice(1, 10).join(', ');
    }
  }

  return values;
}

export { isSite, isPage };
