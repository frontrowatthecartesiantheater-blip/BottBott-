// ============================================================================
// CLIENT CONFIG — the one file to fill in per client.
// ============================================================================
// Every code-consumed, client-specific value lives here. Secrets do NOT
// (those go in .env). The static voice profile does NOT (that goes in
// docs/tov-profile-template.md, loaded by lib/generation/prompts.js).
//
// Replace every {{PLACEHOLDER}} below with the client's real value. The
// system runs as-is for a mock demo with the placeholders in place, but
// publishing and live generation expect real values here.
//
// HTML templates (templates/*.html) reference these via {{TOKEN}} names that
// lib/blog.js fills at build time — see CHROME_TOKENS at the bottom.
// ============================================================================

export const CLIENT = {
  // --- identity & branding -------------------------------------------------
  fullName: 'Simon Dauphinee',
  firstName: 'Simon',                          // used in prompt voice rules & email copy
  businessName: 'BottBott Business Systems',   // schema.org name, og:site_name
  // REVIEW(Simo): drafted role line — used in generation prompts; adjust wording as needed.
  description: 'the founder of BottBott Business Systems, who designs and builds AI-powered automation systems businesses own outright',
  // REVIEW(Simo): drafted from site copy — 1-2 sentence business description for JSON-LD.
  schemaDescription: 'BottBott Business Systems designs and builds AI-powered automation systems — content pipelines, outreach systems, and custom web apps — that clients own outright. No subscriptions, no vendor lock-in.',
  companyName: 'BottBott Business Systems',
  licenseReference: '',                        // no license line for BottBott

  // --- domains -------------------------------------------------------------
  siteDomain: 'www.bottbottgenai.com',             // primary content/SEO site, no protocol
  personalSiteDomain: 'bottbott.substack.com', // secondary site: the BottBott Substack

  // --- contact -------------------------------------------------------------
  contactEmail: 'simon@bottbottgenai.com',     // public contact address
  // FIXME(Simo): no phone is published anywhere on the site — left empty. Fill
  // all three forms if you want a phone in JSON-LD / templates.
  phoneNumber: '',                             // display form, e.g. "555.123.4567"
  phoneE164: '',                               // tel: form, e.g. "+15551234567"
  phoneFormatted: '',                          // e.g. "(555) 123-4567"

  // --- access (Google account whitelist) -----------------------------------
  // The "creator" records voice memos; the "editor" reviews/publishes.
  // (Both currently map to the full editor role in lib/admin-auth.js.)
  // Creator and editor are both Simon on this build.
  creatorGoogleAccount: 'simon@bottbottgenai.com',
  editorGoogleAccount: 'simon@bottbottgenai.com',
  editorName: 'Simon',                                // reminder-email sign-off + from-name

  // --- social --------------------------------------------------------------
  linkedinUrl: 'https://www.linkedin.com/in/simon-d-ai-systems-director-building-for-change',
  googleMapsUrl: 'https://maps.google.com/?cid=3659021546116455577', // Google Business Profile — schema sameAs

  // --- geography (used in JSON-LD; adapt or empty out for non-local clients)-
  // FIXME(Simo): BottBott is worldwide/online, so no primary city or service
  // areas are set. Fill primaryCity only if you want a locality in JSON-LD.
  primaryCity: '',
  serviceAreas: [],                            // JSON-LD areaServed — empty for a worldwide business
  // REVIEW(Simo): drafted expertise tags — JSON-LD knowsAbout.
  expertiseTags: ['AI automation', 'business systems', 'AI content pipelines', 'workflow automation'],
  // CONFIRM(Simo): assumed Belize (UTC-6, no DST) — drives publish-date logic.
  timezone: 'America/Belize',

  // --- JSON-LD schema --------------------------------------------------------
  // schema.org types for the business, most specific first,
  // e.g. ['RealEstateAgent', 'LocalBusiness'] — or just ['LocalBusiness'].
  // Organization (not LocalBusiness): worldwide online business, no street address.
  schemaTypes: ['Organization'],
  schemaImageUrl: 'https://www.bottbottgenai.com/BottBott.png', // logo image for JSON-LD "image"

  // --- topic taxonomy ------------------------------------------------------
  // Must match the CHECK constraints in supabase/schema.sql (topics + images),
  // the <option>s in admin/index.html, and the validator in scripts/seed.js.
  // Domain-specific; replace with the client's categories.
  // FIXME(Simo): topic categories need your input — left as placeholder per
  // instructions. Must be synced with supabase/schema.sql CHECK constraints,
  // admin/index.html <option>s, and scripts/seed.js when filled.
  topicCategories: ['{{TOPIC_CATEGORY}}'],     // e.g. ["news","guides","how-to","community"]

  // --- Add Content tab (AI topic generation) --------------------------------
  // Who the client is and what they write about; injected into every topic
  // generation / extraction prompt (lib/admin-topics-ai.js). 2-4 sentences:
  // name, profession, market, specialties, voice. Example:
  //   "You are helping Jane Doe, a family-law attorney with 20 years of
  //    experience in Sometown County. She specialises in mediation and
  //    custody cases, and also writes about local courts and community life.
  //    Her voice is plain, experienced, and first-person — never hypey."
  // REVIEW(Simo): drafted — tune the voice/specialty description to taste.
  topicAgentContext: 'You are helping Simon Dauphinee, founder of BottBott Business Systems, an AI systems builder who designs automation systems — content pipelines, outreach systems, and custom web apps — that small businesses own outright. He writes about practical AI adoption, workflow automation, and owning your tools instead of renting platforms. His voice is plain, direct, and first-person — no hype, no fluff.',

  // --- image alt-text generation (api/admin/media.js) -----------------------
  // Comma-separated SEO keywords woven into generated alt text where natural,
  // e.g. "family law Sometown, custody attorney, Sometown County mediation".
  // REVIEW(Simo): drafted SEO keywords for generated image alt text.
  altTextKeywords: 'AI automation, business systems, workflow automation, AI content pipeline, BottBott',

  // --- internal link pools (injected into the generation prompts) ----------
  // Pool A = the client's primary site pages; Pool B = secondary site pages.
  // One link from each pool is chosen per post. Keep the dash-list format.
  internalLinkPoolA: `- Home: https://www.bottbottgenai.com/
- Solutions: https://www.bottbottgenai.com/solutions/
- The Autoblog System: https://www.bottbottgenai.com/autoblog/
- Warm Outreach: https://www.bottbottgenai.com/warm-outreach/
- Podcast Pitching: https://www.bottbottgenai.com/podcast-pitching/
- LinkedIn Outreach Pipeline: https://www.bottbottgenai.com/linkedin-outreach-pipeline/
- How We Work: https://www.bottbottgenai.com/how-we-work/
- About: https://www.bottbottgenai.com/about/`,
  internalLinkPoolB: `- BottBott on Substack: https://bottbott.substack.com/`,

  // --- blog index page copy ------------------------------------------------
  // REVIEW(Simo): headline/subhead reuse the homepage posts-section copy.
  blogIndexTitle: 'Blog | BottBott Business Systems',  // <title> + og:title for /blog/
  blogHeroHeadline: 'Latest from BottBott',
  blogHeroSubhead: 'Practical guidance. No hype, no fluff — just what works.',
  blogIndexMetaDescription: 'Practical writing on AI systems, automation, and business workflows from BottBott Business Systems. No hype, no fluff — just what works.',

  // --- post CTA block ------------------------------------------------------
  // REVIEW(Simo): reuses the homepage CTA-banner + contact copy.
  postCtaHeading: 'Ready to stop being the bottleneck?',
  postCtaText: 'Book a free 30-minute strategy call. We will diagnose your biggest workflow pain point and see if there is a fit.',

  // --- admin UI ------------------------------------------------------------
  adminBrandName: 'BottBott',
};

// Convenience derived values used across the code.
export const SITE_ORIGIN = `https://${CLIENT.siteDomain}`;
export const ADMIN_URL = `${SITE_ORIGIN}/admin/`;
// Reminder/review emails read as coming from the editor (you), not the client.
export const FROM_EMAIL = `${CLIENT.editorName} <noreply@${CLIENT.siteDomain}>`;

// Tokens injected into templates/*.html by lib/blog.js at build time. Keep
// the keys in sync with the {{TOKEN}}s used in the HTML templates.
export function chromeTokens() {
  return {
    CLIENT_FULL_NAME: CLIENT.fullName,
    CLIENT_BUSINESS_NAME: CLIENT.businessName,
    CLIENT_SCHEMA_DESCRIPTION: CLIENT.schemaDescription,
    CLIENT_SITE_DOMAIN: CLIENT.siteDomain,
    CLIENT_PERSONAL_SITE_DOMAIN: CLIENT.personalSiteDomain,
    CLIENT_CONTACT_EMAIL: CLIENT.contactEmail,
    CLIENT_PHONE_NUMBER: CLIENT.phoneNumber,
    CLIENT_PHONE_E164: CLIENT.phoneE164,
    CLIENT_PHONE_FORMATTED: CLIENT.phoneFormatted,
    CLIENT_LINKEDIN_URL: CLIENT.linkedinUrl,
    CLIENT_GOOGLE_MAPS_URL: CLIENT.googleMapsUrl,
    CLIENT_PRIMARY_CITY: CLIENT.primaryCity,
    CLIENT_LICENSE_REFERENCE: CLIENT.licenseReference,
    SITE_ORIGIN,
    BLOG_INDEX_TITLE: CLIENT.blogIndexTitle,
    BLOG_HERO_HEADLINE: CLIENT.blogHeroHeadline,
    BLOG_HERO_SUBHEAD: CLIENT.blogHeroSubhead,
    BLOG_INDEX_META_DESCRIPTION: CLIENT.blogIndexMetaDescription,
    POST_CTA_HEADING: CLIENT.postCtaHeading,
    POST_CTA_TEXT: CLIENT.postCtaText,
    // areaServed / knowsAbout are JSON arrays in the schema block.
    CLIENT_SERVICE_AREAS_JSON: CLIENT.serviceAreas.map((c) => `\n      {"@type": "City", "name": ${JSON.stringify(c)}}`).join(','),
    CLIENT_EXPERTISE_TAGS_JSON: JSON.stringify(CLIENT.expertiseTags),
    // @type + image on the base JSON-LD business block.
    CLIENT_SCHEMA_TYPES_JSON: JSON.stringify(CLIENT.schemaTypes),
    CLIENT_SCHEMA_IMAGE_URL: CLIENT.schemaImageUrl,
  };
}
