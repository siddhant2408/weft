const HOST = 'com.margin.host';

// Native messaging errors only surface as lastError strings; map the common one to a fix.
function askHost(req) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(HOST, req, (res) => {
      const err = chrome.runtime.lastError;
      if (err) {
        const missing = /not found|forbidden/i.test(err.message);
        resolve({ ok: false, code: missing ? 'HOST_MISSING' : 'HOST_ERROR',
          detail: missing ? 'Run native-host/install.sh, then reload the extension.' : err.message });
      } else resolve(res);
    });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  if (msg.type === 'llm.ask') {
    askHost({ system: msg.system, prompt: msg.prompt }).then(sendResponse);
    return true;
  }
});
