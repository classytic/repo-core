import { matchFilter } from '../../../src/filter/index.js';
import { parseUrl } from '../../../src/query-parser/index.js';
import { runQueryGrammarConformance } from '../../../src/testing/index.js';

runQueryGrammarConformance('repo-core parseUrl', {
  parse(query, options) {
    const parsed = parseUrl(new URLSearchParams(query), options);
    return {
      matches: (doc) => matchFilter(doc, parsed.filter),
      limit: parsed.limit,
      page: parsed.page,
      after: parsed.after,
      sort: parsed.sort,
    };
  },
});
