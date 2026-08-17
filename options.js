// Settings page logic: enter, validate, save and remove the OpenAlex API key.

const keyInput = document.getElementById('keyInput');
const revealBtn = document.getElementById('revealBtn');
const saveBtn = document.getElementById('saveBtn');
const testBtn = document.getElementById('testBtn');
const clearBtn = document.getElementById('clearBtn');
const getKeyBtn = document.getElementById('getKeyBtn');
const statusEl = document.getElementById('status');
const welcomeEl = document.getElementById('welcome');

// A saved key is shown as a fixed-width mask rather than the real characters, so
// the page never renders the credential. The real value stays in storage until
// the user types a replacement.
const MASK = '••••••••••••••••';
let hasSavedKey = false;

function setStatus(message, kind) {
  statusEl.textContent = message || '';
  statusEl.className = kind ? `status ${kind}` : 'status';
}

function setBusy(busy) {
  [saveBtn, testBtn, clearBtn].forEach((btn) => { btn.disabled = busy; });
}

/** Treat an untouched mask as "no new key typed". */
function typedKey() {
  const value = keyInput.value.trim();
  return value === MASK ? '' : value;
}

// Reported as a percentage rather than in dollars: a free key is never billed,
// so the share of the daily allowance left is the useful number.
function describeBudget(rateLimit) {
  if (!rateLimit || !rateLimit.limitUsd) return '';
  const pct = Math.max(0, Math.min(100, (rateLimit.remainingUsd / rateLimit.limitUsd) * 100));
  const shown = pct === 0 ? '0%' : pct < 1 ? 'under 1%' : `${Math.round(pct)}%`;
  return ` Daily allowance remaining: ${shown}.`;
}

async function render() {
  hasSavedKey = await ANE.hasKey();
  welcomeEl.classList.toggle('hidden', hasSavedKey);
  clearBtn.classList.toggle('hidden', !hasSavedKey);
  if (hasSavedKey) {
    keyInput.value = MASK;
    keyInput.type = 'password';
    revealBtn.textContent = 'Show';
    setStatus('A key is saved. Paste a new one to replace it.', 'ok');
  } else {
    keyInput.value = '';
    setStatus('');
  }
}

getKeyBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: ANE.SIGNUP_URL });
});

revealBtn.addEventListener('click', async () => {
  // Revealing a saved key means fetching the real value, since the field holds a mask.
  if (keyInput.type === 'password') {
    if (hasSavedKey && keyInput.value === MASK) {
      keyInput.value = await ANE.getKey();
    }
    keyInput.type = 'text';
    revealBtn.textContent = 'Hide';
  } else {
    keyInput.type = 'password';
    revealBtn.textContent = 'Show';
  }
});

// Clear the mask on first edit so the user isn't typing into placeholder dots.
keyInput.addEventListener('focus', () => {
  if (keyInput.value === MASK) keyInput.value = '';
});

testBtn.addEventListener('click', async () => {
  const key = typedKey() || (hasSavedKey ? await ANE.getKey() : '');
  if (!key) {
    setStatus('Enter a key first.', 'err');
    return;
  }
  setBusy(true);
  setStatus('Checking with OpenAlex…', 'busy');
  const result = await ANE.validateKey(key);
  setBusy(false);
  setStatus(
    result.ok ? `That key works.${describeBudget(result.rateLimit)}` : result.error,
    result.ok ? 'ok' : 'err'
  );
});

saveBtn.addEventListener('click', async () => {
  const key = typedKey();
  if (!key) {
    setStatus(hasSavedKey ? 'Paste a new key to replace the saved one.' : 'Enter a key first.', 'err');
    return;
  }

  setBusy(true);
  setStatus('Checking with OpenAlex…', 'busy');
  const result = await ANE.validateKey(key);

  // A key that OpenAlex rejects is worse than no key, because every later
  // request fails with a confusing error — so don't save one that fails.
  if (!result.ok) {
    setBusy(false);
    setStatus(`${result.error} Key not saved.`, 'err');
    return;
  }

  await ANE.setKey(key);
  setBusy(false);
  await render();
  setStatus(`Key saved and working.${describeBudget(result.rateLimit)} You're ready to go.`, 'ok');
});

clearBtn.addEventListener('click', async () => {
  await ANE.clearKey();
  await render();
  setStatus('Saved key removed.', 'ok');
});

render();
