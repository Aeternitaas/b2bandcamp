const $ = id => document.getElementById(id);

const linkedView = $('linked-view');
const connectView = $('connect-view');
const stepInstance = $('step-instance');
const stepLogin = $('step-login');
const errorEl = $('error');

let pendingInstanceUrl = '';

/**
 * Normalises whatever the user typed ("b2b.example.com", "example.com/",
 * "http://example.com") into a bare origin, mirrors background.js's own
 * copy: the background service worker cannot request the permission this
 * needs (see ensureOriginPermission below), so the popup must normalise
 * and request it itself, before the origin ever reaches background.js.
 */
function normalizeInstanceUrl(input) {
  let value = input.trim();
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  return new URL(value).origin;
}

/**
 * Requests the host permission a fetch to this origin needs. Must run here,
 * synchronously within a click handler: chrome.permissions.request() only
 * works with an active user gesture, and only a page context (this popup)
 * has one, the background service worker never does, even when a message
 * it's handling was itself triggered by a click a moment ago.
 */
async function ensureOriginPermission(origin) {
  const pattern = `${origin}/*`;
  if (await chrome.permissions.contains({ origins: [pattern] })) return true;
  return chrome.permissions.request({ origins: [pattern] });
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.classList.remove('hidden');
}
function clearError() {
  errorEl.classList.add('hidden');
}

/** Every call to the background worker goes through this, see
 *  background.js's handlers map for what `type` values exist. */
function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, response => {
      if (!response) {
        reject(new Error('The extension background script did not respond.'));
      } else if (response.error) {
        reject(new Error(response.error));
      } else {
        resolve(response.result);
      }
    });
  });
}

async function withButton(button, fn) {
  clearError();
  button.disabled = true;
  try {
    await fn();
  } catch (err) {
    showError(err.message);
  } finally {
    button.disabled = false;
  }
}

async function refresh() {
  const status = await send('getStatus');
  if (status.linked) {
    linkedView.classList.remove('hidden');
    connectView.classList.add('hidden');
    $('linked-url').textContent = status.instanceUrl;
    $('linked-label').textContent = status.label ? `token: ${status.label}` : '';
  } else {
    linkedView.classList.add('hidden');
    connectView.classList.remove('hidden');
    stepInstance.classList.remove('hidden');
    stepLogin.classList.add('hidden');
  }
}

$('connect-btn').addEventListener('click', () => withButton($('connect-btn'), async () => {
  const instanceUrl = $('instance-url').value.trim();
  if (!instanceUrl) throw new Error('Enter your instance URL first.');

  const origin = normalizeInstanceUrl(instanceUrl);
  if (!(await ensureOriginPermission(origin))) {
    throw new Error('Permission to reach that site was not granted.');
  }

  await send('ping', { instanceUrl: origin });
  pendingInstanceUrl = origin;
  $('connected-to').textContent = `Connected to ${origin}, sign in below.`;
  stepInstance.classList.add('hidden');
  stepLogin.classList.remove('hidden');
}));

$('back-btn').addEventListener('click', () => {
  clearError();
  stepLogin.classList.add('hidden');
  stepInstance.classList.remove('hidden');
});

$('login-btn').addEventListener('click', () => withButton($('login-btn'), async () => {
  const login = $('login-input').value.trim();
  const password = $('password-input').value;
  if (!login || !password) throw new Error('Enter your username/email and password.');

  if (!(await ensureOriginPermission(pendingInstanceUrl))) {
    throw new Error('Permission to reach that site was not granted.');
  }

  await send('login', { instanceUrl: pendingInstanceUrl, login, password });
  $('password-input').value = '';
  await refresh();
}));

$('sign-out').addEventListener('click', () => withButton($('sign-out'), async () => {
  await send('logout');
  await refresh();
}));

$('open-instance').addEventListener('click', async () => {
  const status = await send('getStatus');
  if (status.linked) chrome.tabs.create({ url: status.instanceUrl });
});

refresh().catch(err => showError(err.message));
