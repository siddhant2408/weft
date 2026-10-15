// User settings in chrome.storage.local under "settings". Shared by the content script and the options page.
var MarginSettings = (() => {
  // Sites where Weft does nothing at all: no Ask pill, no highlights, nothing ever sent.
  const DEFAULT_EXCLUDED = [
    'mail.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'mail.yahoo.com', 'mail.proton.me',
    'web.whatsapp.com', 'app.slack.com', 'accounts.google.com', 'myaccount.google.com',
    'paypal.com', 'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'capitalone.com', 'americanexpress.com',
    'hdfcbank.com', 'icicibank.com', 'onlinesbi.sbi', 'axisbank.com', 'kotak.com',
  ];

  // "https://www.Example.com/path" → "example.com"; returns '' for junk.
  function normaliseDomain(s) {
    let d = String(s).trim().toLowerCase();
    if (!d || d.startsWith('#')) return '';
    try { d = new URL(d.includes('://') ? d : 'https://' + d).hostname; } catch { return ''; }
    d = d.replace(/^www\./, '');
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : '';
  }

  const isExcluded = (hostname, excluded) => {
    const h = hostname.toLowerCase().replace(/^www\./, '');
    return excluded.some((d) => h === d || h.endsWith('.' + d));
  };

  async function get() {
    const { settings } = await chrome.storage.local.get('settings');
    return { excluded: DEFAULT_EXCLUDED, ...settings };
  }

  return { DEFAULT_EXCLUDED, normaliseDomain, isExcluded, get };
})();
