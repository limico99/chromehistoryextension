// ---------------------------------------------------------------------------
// chrome.history API 콜백을 Promise로 감싸는 헬퍼
// ---------------------------------------------------------------------------
function historySearch(query) {
  return new Promise((resolve) => chrome.history.search(query, resolve));
}
function historyGetVisits(details) {
  return new Promise((resolve) => chrome.history.getVisits(details, resolve));
}
function historyDeleteRange(range) {
  return new Promise((resolve) => chrome.history.deleteRange(range, resolve));
}

// ---------------------------------------------------------------------------
// 상태
// ---------------------------------------------------------------------------
let visitIndex = [];      // { visitId, url, title, visitTime } - 조회 범위 내 전체 방문 기록
let dateCounts = {};       // 'YYYY-MM-DD' -> count
let currentDays = 30;
let currentDate = null;
let mode = 'idle';         // 'idle' | 'date' | 'search'
let lastSearchResults = [];

// ---------------------------------------------------------------------------
// 유틸
// ---------------------------------------------------------------------------
function formatDateLocal(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatTimeLocal(ms) {
  return new Date(ms).toTimeString().slice(0, 8);
}

function dayBounds(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const startTime = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  const endTime = new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime();
  return { startTime, endTime };
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function setInfo(text) {
  document.getElementById('infoBar').textContent = text;
}

function showStatus(kind, text) {
  const status = document.getElementById('status');
  status.className = kind;
  status.textContent = text;
}

function backupEnabled() {
  return document.getElementById('backupToggle').checked;
}

function downloadBackup(items, label) {
  const payload = items.map((it) => ({
    url: it.url,
    title: it.title,
    visitTime: it.visitTime,
    visitTimeLocal: new Date(it.visitTime).toLocaleString('ko-KR'),
  }));
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const a = document.createElement('a');
  a.href = url;
  a.download = `history_backup_${label}_${ts}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------------------------------------------------------------------------
// 방문 기록 인덱스 로딩 (조회 범위 내 전체 방문을 개별 항목 단위로 수집)
// ---------------------------------------------------------------------------
async function fetchVisitsForUrls(urlItems, startTime, endTime, concurrency = 15) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < urlItems.length) {
      const item = urlItems[idx++];
      let visits = [];
      try {
        visits = await historyGetVisits({ url: item.url });
      } catch (e) {
        continue;
      }
      for (const v of visits) {
        if (v.visitTime >= startTime && v.visitTime <= endTime) {
          results.push({
            visitId: v.visitId,
            url: item.url,
            title: item.title || item.url,
            visitTime: v.visitTime,
          });
        }
      }
    }
  }

  const workerCount = Math.min(concurrency, urlItems.length || 1);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

function buildDateCounts() {
  dateCounts = {};
  for (const v of visitIndex) {
    const d = formatDateLocal(v.visitTime);
    dateCounts[d] = (dateCounts[d] || 0) + 1;
  }
}

async function loadAll(days) {
  currentDays = days;
  setInfo('불러오는 중... (방문 기록이 많으면 시간이 걸릴 수 있습니다)');
  document.getElementById('dateList').innerHTML = '<div class="empty">불러오는 중...</div>';

  const endTime = Date.now();
  const startTime = endTime - days * 24 * 60 * 60 * 1000;

  let urlItems = [];
  try {
    urlItems = await historySearch({ text: '', startTime, endTime, maxResults: 10000 });
  } catch (e) {
    setInfo('방문기록을 불러오는 중 오류가 발생했습니다.');
    return;
  }

  const visits = await fetchVisitsForUrls(urlItems, startTime, endTime);
  visits.sort((a, b) => b.visitTime - a.visitTime);
  visitIndex = visits;
  buildDateCounts();
  renderDateList();

  const cappedNote = urlItems.length >= 10000
    ? ' (방문한 고유 URL이 매우 많아 일부만 표시되었을 수 있습니다)'
    : '';
  setInfo(`최근 ${days}일 기준 · 고유 URL ${urlItems.length}개 · 방문 기록 ${visitIndex.length}건${cappedNote}`);
}

// ---------------------------------------------------------------------------
// 날짜 목록 렌더링
// ---------------------------------------------------------------------------
function renderDateList() {
  const container = document.getElementById('dateList');
  const dates = Object.keys(dateCounts).sort().reverse();

  if (dates.length === 0) {
    container.innerHTML = '<div class="empty">방문기록이 없습니다.</div>';
    updateDateSelectedCount();
    return;
  }

  container.innerHTML = '';
  dates.forEach((date) => {
    const el = document.createElement('div');
    el.className = 'date-item';
    el.dataset.date = date;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'date-check';
    checkbox.dataset.date = date;
    checkbox.addEventListener('click', (e) => e.stopPropagation());
    checkbox.addEventListener('change', updateDateSelectedCount);

    const label = document.createElement('span');
    label.className = 'date-label';
    label.textContent = date;

    const count = document.createElement('span');
    count.className = 'date-count';
    count.textContent = dateCounts[date];

    el.appendChild(checkbox);
    el.appendChild(label);
    el.appendChild(count);
    el.addEventListener('click', () => selectDate(date, el));
    container.appendChild(el);
  });

  updateDateSelectedCount();
}

function updateDateSelectedCount() {
  const n = document.querySelectorAll('.date-check:checked').length;
  document.getElementById('dateSelectedCount').textContent = n > 0 ? `${n}개 날짜 선택됨` : '';
  document.getElementById('dateDeleteBtn').disabled = n === 0;
}

function selectDate(date, el) {
  mode = 'date';
  currentDate = date;
  document.querySelectorAll('.date-item').forEach((x) => x.classList.remove('active'));
  if (el) el.classList.add('active');
  document.getElementById('status').textContent = '';

  const items = visitIndex
    .filter((v) => formatDateLocal(v.visitTime) === date)
    .sort((a, b) => b.visitTime - a.visitTime);

  renderTable(items, false, '이 날짜의 방문기록이 없습니다.');
}

// ---------------------------------------------------------------------------
// 검색 (조회 범위와 무관하게 전체 방문기록을 대상으로 함)
// ---------------------------------------------------------------------------
async function runSearch() {
  const keyword = document.getElementById('searchInput').value.trim();
  if (!keyword) return;

  mode = 'search';
  document.querySelectorAll('.date-item').forEach((x) => x.classList.remove('active'));
  document.getElementById('status').textContent = '';
  document.getElementById('tableWrap').innerHTML = '<div class="empty">검색 중...</div>';

  let matches = [];
  try {
    matches = await historySearch({ text: keyword, startTime: 0, maxResults: 300 });
  } catch (e) {
    renderTable([], true, '검색 중 오류가 발생했습니다.');
    return;
  }

  const results = [];
  let idx = 0;
  const concurrency = 15;

  async function worker() {
    while (idx < matches.length) {
      const item = matches[idx++];
      let visits = [];
      try {
        visits = await historyGetVisits({ url: item.url });
      } catch (e) {
        continue;
      }
      const top = visits.slice().sort((a, b) => b.visitTime - a.visitTime).slice(0, 20);
      for (const v of top) {
        results.push({
          visitId: v.visitId,
          url: item.url,
          title: item.title || item.url,
          visitTime: v.visitTime,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, matches.length || 1) }, worker));
  results.sort((a, b) => b.visitTime - a.visitTime);
  lastSearchResults = results.slice(0, 500);
  renderTable(lastSearchResults, true, '검색 결과가 없습니다.');
}

// ---------------------------------------------------------------------------
// 테이블 렌더링 (날짜별 보기 / 검색 결과 공용)
// ---------------------------------------------------------------------------
function renderTable(items, withDate, emptyMsg) {
  const wrap = document.getElementById('tableWrap');
  const toolbar = document.getElementById('toolbar');

  if (!items || items.length === 0) {
    wrap.innerHTML = `<div class="empty">${emptyMsg}</div>`;
    toolbar.style.display = 'none';
    return;
  }

  toolbar.style.display = 'flex';
  const dateCol = withDate ? '<th>날짜</th>' : '';
  const rows = items.map((it) => `
    <tr>
      <td><input type="checkbox" class="row-check" data-id="${it.visitId}"></td>
      ${withDate ? `<td>${formatDateLocal(it.visitTime)}</td>` : ''}
      <td>${formatTimeLocal(it.visitTime)}</td>
      <td class="title" title="${escapeHtml(it.title)}">${escapeHtml(it.title)}</td>
      <td class="url" title="${escapeHtml(it.url)}">${escapeHtml(it.url)}</td>
    </tr>`).join('');

  wrap.innerHTML = `
    <table>
      <thead><tr><th></th>${dateCol}<th>시간</th><th>제목</th><th>URL</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  updateSelectedCount();
  document.querySelectorAll('.row-check').forEach((cb) => cb.addEventListener('change', updateSelectedCount));
}

function updateSelectedCount() {
  const n = document.querySelectorAll('.row-check:checked').length;
  document.getElementById('selectedCount').textContent = n > 0 ? `${n}개 선택됨` : '';
  document.getElementById('deleteBtn').disabled = n === 0;
}

function resetView() {
  currentDate = null;
  mode = 'idle';
  document.querySelectorAll('.date-item').forEach((x) => x.classList.remove('active'));
  document.getElementById('tableWrap').innerHTML = '<div class="empty">왼쪽에서 날짜를 선택하거나, 위에서 검색해보세요.</div>';
  document.getElementById('toolbar').style.display = 'none';
  document.getElementById('status').textContent = '';
  document.getElementById('searchInput').value = '';
}

// ---------------------------------------------------------------------------
// 삭제: 개별 항목 선택 삭제 (날짜별 보기 / 검색 결과 공용)
//   - 각 방문을 정확한 시각(visitTime) 기준의 좁은 시간창으로 deleteRange 호출해
//     같은 URL의 다른 날짜 방문 기록은 건드리지 않습니다.
// ---------------------------------------------------------------------------
document.getElementById('deleteBtn').addEventListener('click', async () => {
  const ids = new Set([...document.querySelectorAll('.row-check:checked')].map((b) => b.dataset.id));
  if (ids.size === 0) return;

  const source = mode === 'search'
    ? lastSearchResults
    : visitIndex.filter((v) => formatDateLocal(v.visitTime) === currentDate);
  const selectedItems = source.filter((it) => ids.has(String(it.visitId)));
  if (selectedItems.length === 0) return;

  const backupMsg = backupEnabled() ? ' (삭제 전 백업 파일이 다운로드됩니다)' : ' (백업 없이 바로 삭제됩니다)';
  if (!confirm(`선택한 ${selectedItems.length}개 항목을 삭제할까요?${backupMsg}`)) return;

  if (backupEnabled()) downloadBackup(selectedItems, 'selected_items');

  for (const it of selectedItems) {
    await historyDeleteRange({ startTime: it.visitTime, endTime: it.visitTime + 1 });
  }

  showStatus('ok', `삭제 완료 (${selectedItems.length}건).`);
  const wasDate = mode === 'date' ? currentDate : null;
  const wasSearch = mode === 'search';
  await loadAll(currentDays);

  if (wasDate) {
    const el = document.querySelector(`.date-item[data-date="${wasDate}"]`);
    selectDate(wasDate, el);
  } else if (wasSearch) {
    await runSearch();
  }
});

// ---------------------------------------------------------------------------
// 삭제: 왼쪽 날짜 목록에서 여러 날짜 체크박스 선택 후 일괄 삭제
// ---------------------------------------------------------------------------
document.getElementById('dateDeleteBtn').addEventListener('click', async () => {
  const dates = [...document.querySelectorAll('.date-check:checked')].map((b) => b.dataset.date);
  if (dates.length === 0) return;

  const backupMsg = backupEnabled() ? ' 백업 파일이 다운로드됩니다.' : ' 백업 없이 바로 삭제됩니다.';
  if (!confirm(`선택한 ${dates.length}개 날짜의 방문기록을 모두 삭제할까요?${backupMsg}`)) return;

  const itemsToBackup = visitIndex.filter((v) => dates.includes(formatDateLocal(v.visitTime)));
  if (backupEnabled()) downloadBackup(itemsToBackup, 'selected_dates');

  for (const d of dates) {
    const { startTime, endTime } = dayBounds(d);
    await historyDeleteRange({ startTime, endTime });
  }

  showStatus('ok', `선택한 ${dates.length}개 날짜 삭제 완료 (조회 범위 내 ${itemsToBackup.length}건 기준).`);
  await loadAll(currentDays);
  resetView();
});

// ---------------------------------------------------------------------------
// 삭제: 날짜 범위 일괄 삭제
// ---------------------------------------------------------------------------
document.getElementById('rangeDeleteBtn').addEventListener('click', async () => {
  const startVal = document.getElementById('rangeStart').value;
  const endVal = document.getElementById('rangeEnd').value;
  if (!startVal || !endVal) {
    alert('시작일과 종료일을 모두 선택해주세요.');
    return;
  }
  const [s, e] = startVal <= endVal ? [startVal, endVal] : [endVal, startVal];

  const backupMsg = backupEnabled() ? ' 백업 파일이 다운로드됩니다.' : ' 백업 없이 바로 삭제됩니다.';
  if (!confirm(`${s} ~ ${e} 기간의 모든 방문기록을 삭제할까요?${backupMsg}`)) return;

  const startTime = dayBounds(s).startTime;
  const endTime = dayBounds(e).endTime;
  const itemsToBackup = visitIndex.filter((v) => v.visitTime >= startTime && v.visitTime < endTime);
  if (backupEnabled()) downloadBackup(itemsToBackup, 'date_range');

  await historyDeleteRange({ startTime, endTime });

  showStatus('ok', `기간 삭제 완료 (조회 범위 내 ${itemsToBackup.length}건 기준).`);
  await loadAll(currentDays);
  resetView();
});

// ---------------------------------------------------------------------------
// 기타 UI 이벤트
// ---------------------------------------------------------------------------
document.getElementById('dateSelectAllBtn').addEventListener('click', () => {
  const boxes = document.querySelectorAll('.date-check');
  const allChecked = [...boxes].every((b) => b.checked);
  boxes.forEach((b) => { b.checked = !allChecked; });
  updateDateSelectedCount();
});

document.getElementById('selectAllBtn').addEventListener('click', () => {
  const boxes = document.querySelectorAll('.row-check');
  const allChecked = [...boxes].every((b) => b.checked);
  boxes.forEach((b) => { b.checked = !allChecked; });
  updateSelectedCount();
});

document.getElementById('searchBtn').addEventListener('click', runSearch);
document.getElementById('searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runSearch();
});
document.getElementById('clearSearchBtn').addEventListener('click', resetView);

document.getElementById('backupToggle').addEventListener('change', () => {
  chrome.storage.local.set({ backupDefault: document.getElementById('backupToggle').checked });
});

document.getElementById('rangeSelect').addEventListener('change', (e) => {
  resetView();
  loadAll(Number(e.target.value));
});

document.getElementById('reloadBtn').addEventListener('click', () => {
  resetView();
  loadAll(currentDays);
});

document.getElementById('scheduleBtn').addEventListener('click', () => {
  window.location.href = 'scheduler.html';
});

// ---------------------------------------------------------------------------
// 초기화
// ---------------------------------------------------------------------------
(async function init() {
  await new Promise((resolve) => {
    chrome.storage.local.get({ backupDefault: true }, (data) => {
      document.getElementById('backupToggle').checked = !!data.backupDefault;
      resolve();
    });
  });
  await loadAll(Number(document.getElementById('rangeSelect').value));
})();
