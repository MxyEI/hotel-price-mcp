const state = {
  sessionId: '',
  pollTimer: null,
};

const els = {
  healthButton: document.querySelector('#healthButton'),
  healthStatus: document.querySelector('#healthStatus'),
  browserPoolCount: document.querySelector('#browserPoolCount'),
  closeAllBrowsersButton: document.querySelector('#closeAllBrowsersButton'),
  priceForm: document.querySelector('#priceForm'),
  resultRows: document.querySelector('#resultRows'),
  manualProvider: document.querySelector('#manualProvider'),
  openBrowserButton: document.querySelector('#openBrowserButton'),
  closeBrowserButton: document.querySelector('#closeBrowserButton'),
  openSearchUrl: document.querySelector('#openSearchUrl'),
  sessionId: document.querySelector('#sessionId'),
  sessionStatus: document.querySelector('#sessionStatus'),
  fingerprintSeed: document.querySelector('#fingerprintSeed'),
  browserLog: document.querySelector('#browserLog'),
  keepBrowserOpen: document.querySelector('#keepBrowserOpen'),
  proxyEnabled: document.querySelector('#proxyEnabled'),
  proxyUrl: document.querySelector('#proxyUrl'),
  proxyExtractUrl: document.querySelector('#proxyExtractUrl'),
  proxyExtractButton: document.querySelector('#proxyExtractButton'),
  proxyInfo: document.querySelector('#proxyInfo'),
  proxySaveButton: document.querySelector('#proxySaveButton'),
  proxyTestButton: document.querySelector('#proxyTestButton'),
  proxyTestResult: document.querySelector('#proxyTestResult'),
};

els.healthButton.addEventListener('click', checkHealth);
els.priceForm.addEventListener('submit', handlePriceSubmit);
els.openBrowserButton.addEventListener('click', openManualBrowser);
els.closeBrowserButton.addEventListener('click', closeManualBrowser);
els.closeAllBrowsersButton.addEventListener('click', closeAllBrowsers);
els.proxySaveButton.addEventListener('click', saveProxy);
els.proxyTestButton.addEventListener('click', testProxy);
els.proxyExtractButton.addEventListener('click', extractProxy);

await checkHealth();
await refreshBrowserPool();
await refreshBrowserSessions();
await loadProxyConfig();

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
    await refreshBrowserPool();
  } catch (error) {
    els.resultRows.innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(error.message)}</td></tr>`;
  }
}

async function openManualBrowser() {
  const provider = els.manualProvider.value;
  const payload = {
    provider,
  };

  if (els.openSearchUrl.checked) {
    Object.assign(payload, formPayload());
  } else {
    payload.targetUrl = providerHomeUrl(provider);
  }

  els.openBrowserButton.disabled = true;
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
    els.openBrowserButton.disabled = false;
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
    els.openBrowserButton.disabled = false;
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
      els.openBrowserButton.disabled = false;
    }
  } catch (error) {
    stopPolling();
    writeBrowserLog(`状态查询失败: ${error.message}`);
    els.openBrowserButton.disabled = false;
  }
}

async function refreshBrowserPool() {
  try {
    const data = await apiGet('/browsers');
    const count = data.count ?? 0;
    els.browserPoolCount.textContent = `${count} 个`;
    els.closeAllBrowsersButton.disabled = count === 0;
  } catch {
    els.browserPoolCount.textContent = '未知';
    els.closeAllBrowsersButton.disabled = true;
  }
}

async function closeAllBrowsers() {
  els.closeAllBrowsersButton.disabled = true;
  try {
    await apiPost('/browsers/close-all', {});
    await refreshBrowserPool();
  } catch (error) {
    els.closeAllBrowsersButton.disabled = false;
  }
}

async function refreshBrowserSessions() {
  try {
    const data = await apiGet('/manual-browser/sessions');
    const open = (data.sessions ?? []).filter((item) => item.status === 'open' || item.status === 'starting');
    if (!state.sessionId && open[0]) {
      state.sessionId = open[0].id;
      renderSession(open[0]);
      startPolling();
    }
  } catch {
    // ignore
  }
}

function renderSession(session) {
  if (!session) {
    els.sessionId.textContent = '-';
    els.sessionStatus.textContent = '未启动';
    els.fingerprintSeed.textContent = '-';
    els.closeBrowserButton.disabled = true;
    return;
  }

  els.sessionId.textContent = session.id;
  els.sessionStatus.textContent = statusText(session.status);
  els.fingerprintSeed.textContent = session.fingerprintSeed ?? '-';
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
  const providers = data.getAll('providers');
  return {
    hotelName: String(data.get('hotelName') || '').trim(),
    checkIn: String(data.get('checkIn') || ''),
    checkOut: String(data.get('checkOut') || ''),
    rooms: Number(data.get('rooms') || 1),
    adults: Number(data.get('adults') || 2),
    children: Number(data.get('children') || 0),
    providers: providers.length > 0 ? providers : undefined,
    keepBrowserOpen: els.keepBrowserOpen.checked,
  };
}

function providerHomeUrl(provider) {
  switch (provider) {
    case 'ctrip':
      return 'https://www.ctrip.com/';
    case 'ihg':
      return 'https://www.ihg.com.cn/hotels/cn/zh/reservation';
    case 'marriott':
      return 'https://www.marriott.com.cn/default.mi';
    default:
      return 'https://www.marriott.com.cn/default.mi';
  }
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

// --- Proxy config ---

async function loadProxyConfig() {
  try {
    const config = await apiGet('/proxy');
    els.proxyEnabled.checked = config.enabled;
    els.proxyUrl.value = config.url || '';
    els.proxyExtractUrl.value = config.extractUrl || '';
    if (config.expiredAt) {
      showProxyInfo(config.expiredAt);
    }
  } catch {
    // ignore
  }
}

async function saveProxy() {
  const url = els.proxyUrl.value.trim();
  const enabled = els.proxyEnabled.checked;
  const extractUrl = els.proxyExtractUrl.value.trim();

  try {
    const config = await apiPut('/proxy', { url, enabled, extractUrl });
    if (config.expiredAt) {
      showProxyInfo(config.expiredAt);
    }
    showProxyResult('success', '保存成功');
  } catch (error) {
    showProxyResult('error', `保存失败: ${error.message}`);
  }
}

async function extractProxy() {
  // 先保存提取链接
  const extractUrl = els.proxyExtractUrl.value.trim();
  if (!extractUrl) {
    showProxyResult('error', '请填写提取链接');
    return;
  }

  await apiPut('/proxy', { extractUrl }).catch(() => {});

  showProxyResult('testing', '正在从提取链接获取代理...');
  els.proxyExtractButton.disabled = true;

  try {
    const result = await apiPost('/proxy/extract', {});
    if (result.success) {
      els.proxyUrl.value = result.proxyUrl;
      els.proxyEnabled.checked = true;
      if (result.expiredAt) {
        showProxyInfo(result.expiredAt);
      }
      showProxyResult('success', `提取成功 — ${result.ip}:${result.port}`);
    } else {
      showProxyResult('error', `提取失败: ${result.error}`);
    }
  } catch (error) {
    showProxyResult('error', `提取失败: ${error.message}`);
  } finally {
    els.proxyExtractButton.disabled = false;
  }
}

async function testProxy() {
  showProxyResult('testing', '正在测试连接...');
  els.proxyTestButton.disabled = true;

  try {
    const result = await apiPost('/proxy/test', {});
    if (result.success) {
      showProxyResult('success', `连接成功 — ${result.host}:${result.port}，延迟 ${result.latencyMs}ms`);
    } else {
      showProxyResult('error', `连接失败: ${result.error}`);
    }
  } catch (error) {
    showProxyResult('error', `测试失败: ${error.message}`);
  } finally {
    els.proxyTestButton.disabled = false;
  }
}

function showProxyResult(type, message) {
  els.proxyTestResult.textContent = message;
  els.proxyTestResult.className = `proxy-result show ${type}`;
}

function showProxyInfo(expiredAt) {
  if (!expiredAt) {
    els.proxyInfo.textContent = '';
    els.proxyInfo.style.display = 'none';
    return;
  }
  const expireDate = new Date(expiredAt);
  const remaining = Math.max(0, Math.floor((expiredAt - Date.now()) / 60_000));
  els.proxyInfo.textContent = `到期时间: ${expireDate.toLocaleString('zh-CN')}（剩余 ${remaining} 分钟）`;
  els.proxyInfo.style.display = 'block';
}

async function apiPut(url, body) {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error || `HTTP ${response.status}`);
  }
  return data;
}
