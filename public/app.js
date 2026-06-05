const state = {
  sessionId: '',
  pollTimer: null,
};

const els = {
  healthButton: document.querySelector('#healthButton'),
  healthStatus: document.querySelector('#healthStatus'),
  browserSummary: document.querySelector('#browserSummary'),
  priceForm: document.querySelector('#priceForm'),
  resultRows: document.querySelector('#resultRows'),
  openMarriottButton: document.querySelector('#openMarriottButton'),
  closeBrowserButton: document.querySelector('#closeBrowserButton'),
  openSearchUrl: document.querySelector('#openSearchUrl'),
  sessionId: document.querySelector('#sessionId'),
  sessionStatus: document.querySelector('#sessionStatus'),
  fingerprintSeed: document.querySelector('#fingerprintSeed'),
  browserLog: document.querySelector('#browserLog'),
};

els.healthButton.addEventListener('click', checkHealth);
els.priceForm.addEventListener('submit', handlePriceSubmit);
els.openMarriottButton.addEventListener('click', openMarriottBrowser);
els.closeBrowserButton.addEventListener('click', closeManualBrowser);

await checkHealth();
await refreshBrowserSessions();

async function checkHealth() {
  try {
    const data = await apiGet('/health');
    els.healthStatus.textContent = data.ok ? '正常' : '异常';
  } catch (error) {
    els.healthStatus.textContent = `异常: ${error.message}`;
  }
}

async function handlePriceSubmit(event) {
  event.preventDefault();
  const payload = formPayload();
  setResultLoading();

  try {
    const data = await apiPost('/price/query', payload);
    renderResults(data.results ?? []);
  } catch (error) {
    els.resultRows.innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(error.message)}</td></tr>`;
  }
}

async function openMarriottBrowser() {
  const payload = {
    provider: 'marriott',
  };

  if (els.openSearchUrl.checked) {
    Object.assign(payload, formPayload());
  } else {
    payload.targetUrl = 'https://www.marriott.com/default.mi';
  }

  els.openMarriottButton.disabled = true;
  writeBrowserLog('正在启动 CloakBrowser...');

  try {
    const session = await apiPost('/manual-browser/start', payload);
    state.sessionId = session.id;
    renderSession(session);
    startPolling();
    writeBrowserLog([
      '浏览器启动请求已提交',
      `session: ${session.id}`,
      `fingerprint: ${session.fingerprintSeed ?? '-'}`,
      `target: ${session.targetUrl}`,
    ].join('\n'));
  } catch (error) {
    writeBrowserLog(`启动失败: ${error.message}`);
    els.openMarriottButton.disabled = false;
  }
}

async function closeManualBrowser() {
  if (!state.sessionId) {
    return;
  }

  els.closeBrowserButton.disabled = true;
  writeBrowserLog(`正在关闭浏览器: ${state.sessionId}`);

  try {
    await apiPost(`/manual-browser/close/${encodeURIComponent(state.sessionId)}`, {});
    stopPolling();
    state.sessionId = '';
    renderSession();
    await refreshBrowserSessions();
    writeBrowserLog('浏览器已关闭');
  } catch (error) {
    writeBrowserLog(`关闭失败: ${error.message}`);
  } finally {
    els.openMarriottButton.disabled = false;
  }
}

function startPolling() {
  stopPolling();
  state.pollTimer = window.setInterval(pollSession, 2000);
  void pollSession();
}

function stopPolling() {
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function pollSession() {
  if (!state.sessionId) {
    return;
  }

  try {
    const session = await apiGet(`/manual-browser/status/${encodeURIComponent(state.sessionId)}`);
    renderSession(session);
    if (session.status === 'closed' || session.status === 'error') {
      stopPolling();
      els.openMarriottButton.disabled = false;
    }
  } catch (error) {
    stopPolling();
    writeBrowserLog(`状态查询失败: ${error.message}`);
    els.openMarriottButton.disabled = false;
  }
}

async function refreshBrowserSessions() {
  try {
    const data = await apiGet('/manual-browser/sessions');
    const open = (data.sessions ?? []).filter((item) => item.status === 'open' || item.status === 'starting');
    els.browserSummary.textContent = open.length > 0 ? `${open.length} 个会话` : '未启动';
    if (!state.sessionId && open[0]) {
      state.sessionId = open[0].id;
      renderSession(open[0]);
      startPolling();
    }
  } catch {
    els.browserSummary.textContent = '未知';
  }
}

function renderSession(session) {
  if (!session) {
    els.sessionId.textContent = '-';
    els.sessionStatus.textContent = '未启动';
    els.fingerprintSeed.textContent = '-';
    els.browserSummary.textContent = '未启动';
    els.closeBrowserButton.disabled = true;
    return;
  }

  els.sessionId.textContent = session.id;
  els.sessionStatus.textContent = statusText(session.status);
  els.fingerprintSeed.textContent = session.fingerprintSeed ?? '-';
  els.browserSummary.textContent = statusText(session.status);
  els.closeBrowserButton.disabled = session.status !== 'open' && session.status !== 'starting';

  const lines = [
    `状态: ${statusText(session.status)}`,
    `当前 URL: ${session.currentUrl ?? '-'}`,
    `目标 URL: ${session.targetUrl}`,
    `Profile: ${session.profileDir}`,
  ];
  if (session.errorMessage) {
    lines.push(`错误: ${session.errorMessage}`);
  }
  writeBrowserLog(lines.join('\n'));
}

function renderResults(results) {
  if (results.length === 0) {
    els.resultRows.innerHTML = '<tr><td colspan="6" class="empty">暂无结果</td></tr>';
    return;
  }

  els.resultRows.innerHTML = results.map((item) => `
    <tr>
      <td>${escapeHtml(item.provider)}</td>
      <td>${escapeHtml(item.matchedHotelName || item.hotelName || '-')}</td>
      <td><span class="badge ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></td>
      <td>${item.lowestPrice ?? '-'}</td>
      <td>${escapeHtml(item.currency || '-')}</td>
      <td>${escapeHtml(item.errorMessage || '')}</td>
    </tr>
  `).join('');
}

function setResultLoading() {
  els.resultRows.innerHTML = '<tr><td colspan="6" class="empty">查询中...</td></tr>';
}

function formPayload() {
  const data = new FormData(els.priceForm);
  return {
    hotelName: String(data.get('hotelName') || '').trim(),
    checkIn: String(data.get('checkIn') || ''),
    checkOut: String(data.get('checkOut') || ''),
    rooms: Number(data.get('rooms') || 1),
    adults: Number(data.get('adults') || 2),
    children: Number(data.get('children') || 0),
  };
}

async function apiGet(url) {
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function apiPost(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error || `HTTP ${response.status}`);
  }
  return data;
}

function statusText(status) {
  switch (status) {
    case 'starting':
      return '启动中';
    case 'open':
      return '已打开';
    case 'closed':
      return '已关闭';
    case 'error':
      return '错误';
    default:
      return status || '未启动';
  }
}

function writeBrowserLog(text) {
  els.browserLog.textContent = text;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
