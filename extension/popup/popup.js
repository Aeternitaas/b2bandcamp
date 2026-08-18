const $ = id => document.getElementById(id);

const linkedView = $('linked-view');
const connectView = $('connect-view');
const stepInstance = $('step-instance');
const stepLogin = $('step-login');
const errorEl = $('error');

let pendingInstanceUrl = '';

function showError(message) {
  errorEl.textContent = message;
  errorEl.classList.remove('hidden');
}
function clearError() {
  errorEl.classList.add('hidden');
}

/** Every call to the background worker goes through this — see
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

  const { origin } = await send('ping', { instanceUrl });
  pendingInstanceUrl = origin;
  $('connected-to').textContent = `Connected to ${origin} — sign in below.`;
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
