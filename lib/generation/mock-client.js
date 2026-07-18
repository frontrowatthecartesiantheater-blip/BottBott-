// Offline client: serves pre-authored responses from a fixture directory
// instead of calling the API. The call-3 response is assembled into the
// exact production format (JSON package between |||OUTPUT_START||| markers,
// craft audit after), so the engine's parser is exercised for real.
//
// Fixture directory layout:
//   prepass.json       — dynamic TOV JSON
//   call1.txt          — structure plan
//   call2.md           — full draft incl. ---SEO_METADATA--- block
//   call3/polished-post.md
//   call3/linkedin.txt
//   call3/facebook.txt
//   call3/craft-audit.txt
//   call3/package-fields.json  — { title, slug, meta_title, meta_description,
//                                  internal_links (0-2 URLs; legacy fixtures
//                                  with internal_link_a/_b still work) }

import { readFileSync } from 'node:fs';
import path from 'node:path';

export function createMockClient({ fixtureDir, primaryKeyword, ragFlag = false }) {
  const read = (...parts) => readFileSync(path.join(fixtureDir, ...parts), 'utf8').replace(/\r\n/g, '\n');

  function buildCall3Response() {
    const polishedPost = read('call3', 'polished-post.md').trim();
    const linkedin = read('call3', 'linkedin.txt').trim();
    const facebook = read('call3', 'facebook.txt').trim();
    const craftAudit = read('call3', 'craft-audit.txt').trim();
    const fields = JSON.parse(read('call3', 'package-fields.json'));

    // Emit the production Call 3 shape: internal_links is an array of 0-2
    // URLs (second — or both — may be absent). Legacy a/b fixture fields are
    // folded in so older fixtures keep working.
    const internalLinks = fields.internal_links
      ?? [fields.internal_link_a, fields.internal_link_b].filter(Boolean);

    const pkg = {
      post: {
        title: fields.title,
        slug: fields.slug,
        meta_title: fields.meta_title,
        meta_description: fields.meta_description,
        primary_keyword: primaryKeyword,
        body_md: polishedPost,
        internal_links: internalLinks,
        rag_fallback: ragFlag,
      },
      social: { linkedin, facebook },
    };

    return [
      polishedPost,
      '',
      '---',
      '',
      '## LINKEDIN DRAFT',
      '',
      linkedin,
      '',
      '## FACEBOOK DRAFT',
      '',
      facebook,
      '',
      '|||OUTPUT_START|||',
      JSON.stringify(pkg, null, 2),
      '|||OUTPUT_END|||',
      '',
      craftAudit,
    ].join('\n');
  }

  return async function mockClient({ label }) {
    switch (label) {
      case 'prepass': return read('prepass.json');
      case 'call1': return read('call1.txt');
      case 'call2': return read('call2.md');
      case 'call3': return buildCall3Response();
      default: throw new Error(`mock client has no fixture for label "${label}"`);
    }
  };
}
