// M0 spike: popup → background → native host → claude -p → reply, with timing.
const $ = (id) => document.getElementById(id);

$('go').onclick = async () => {
  $('go').disabled = true;
  $('out').className = '';
  $('out').textContent = 'Waiting…';
  const t0 = performance.now();
  const res = await chrome.runtime.sendMessage({ type: 'llm.ask', system: 'You are a reading companion.', prompt: $('q').value });
  const total = Math.round(performance.now() - t0);
  if (res.ok) {
    $('out').textContent = res.text;
  } else {
    $('out').className = 'err';
    $('out').textContent = `${res.code}: ${res.detail}`;
  }
  $('meta').textContent = `${total} ms total` + (res.ms ? `, ${res.ms} ms in claude` : '');
  $('go').disabled = false;
};
