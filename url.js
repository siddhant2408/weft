// One record per article: tracking params, #fragments and trailing slashes don't make a new page.
const DROP = /^(utm_|mc_)|^(fbclid|gclid|ref)$/;
const bare = (h) => h.replace(/^www\./, '');

export function normaliseUrl(url, canonical) {
  let u = new URL(url);
  if (canonical) {
    try {
      const c = new URL(canonical, url);
      // same-site only: a page can't claim to be some other site's article
      if (/^https?:$/.test(c.protocol) && bare(c.hostname) === bare(u.hostname)) u = c;
    } catch {}
  }
  const params = [...u.searchParams]
    .filter(([k]) => !DROP.test(k.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const search = params.length ? '?' + new URLSearchParams(params) : '';
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${search}`;
}
