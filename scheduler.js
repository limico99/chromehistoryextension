const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

// ---------------------------------------------------------------------------
// 저장소 / 백그라운드 통신 헬퍼
// ---------------------------------------------------------------------------
function loadRules() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ scheduleRules: [] }, (data) => resolve(data.scheduleRules || []));
  });
}
function saveRules(rules) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ scheduleRules: rules }, resolve);
  });
}
function syncAlarms() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'SYNC_ALARMS' }, () => resolve());
  });
}
function runRuleNow(ruleId) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'RUN_RULE_NOW', ruleId }, (res) => resolve(res));
  });
}

function genId() {
  return 'rule_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function showStatus(kind, text) {
  const status = document.getElementById('status');
  status.className = kind;
  status.textContent = text;
}

// background.js의 computeNextRun과 동일한 로직 (화면 표시용)
function computeNextRun(rule, fromTime = Date.now()) {
  const [hh, mm] = (rule.time || '00:00').split(':').map(Number);

  if (rule.frequency === 'once') {
    const parts = (rule.date || '').split('-').map(Number);
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
    const [y, m, d] = parts;
    return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
  }

  if (rule.frequency === 'daily') {
    const now = new Date(fromTime);
    let next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
    if (next.getTime() <= fromTime) next = new Date(next.getTime() + 24 * 60 * 60 * 1000);
    return next.getTime();
  }

  if (rule.frequency === 'weekly') {
    const targetWeekday = Number(rule.weekday);
    const now = new Date(fromTime);
    let next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
    const diff = (targetWeekday - next.getDay() + 7) % 7;
    next = new Date(next.getTime() + diff * 24 * 60 * 60 * 1000);
    if (next.getTime() <= fromTime) next = new Date(next.getTime() + 7 * 24 * 60 * 60 * 1000);
    return next.getTime();
  }

  return null;
}

// ---------------------------------------------------------------------------
// 폼 표시 전환
// ---------------------------------------------------------------------------
const freqSelect = document.getElementById('freqSelect');
const weekdaySelect = document.getElementById('weekdaySelect');
const onceDate = document.getElementById('onceDate');
const retentionDays = document.getElementById('retentionDays');
const deleteAllToggle = document.getElementById('deleteAllToggle');

function updateFormVisibility() {
  const freq = freqSelect.value;
  weekdaySelect.style.display = freq === 'weekly' ? '' : 'none';
  onceDate.style.display = freq === 'once' ? '' : 'none';
  retentionDays.disabled = deleteAllToggle.checked;
}
freqSelect.addEventListener('change', updateFormVisibility);
deleteAllToggle.addEventListener('change', updateFormVisibility);
updateFormVisibility();

// ---------------------------------------------------------------------------
// 예약 목록 렌더링
// ---------------------------------------------------------------------------
async function renderRules() {
  const rules = await loadRules();
  const container = document.getElementById('ruleList');

  if (rules.length === 0) {
    container.innerHTML = '<div class="empty">등록된 예약이 없습니다.</div>';
    return;
  }

  container.innerHTML = '';
  rules.forEach((rule) => {
    const el = document.createElement('div');
    el.className = 'rule-card';

    const freqLabel = rule.frequency === 'once'
      ? `한 번만 (${rule.date})`
      : rule.frequency === 'weekly'
        ? `매주 ${WEEKDAY_LABELS[Number(rule.weekday)]}요일`
        : '매일';

    const target = Number(rule.retentionDays) > 0
      ? `최근 ${rule.retentionDays}일은 남기고 그 이전 기록 삭제`
      : '전체 방문기록 삭제';

    const nextRun = rule.enabled ? computeNextRun(rule) : null;
    const nextRunText = nextRun ? `다음 실행: ${new Date(nextRun).toLocaleString('ko-KR')}` : '비활성화됨';
    const lastRunText = rule.lastRun
      ? ` · 마지막 실행: ${new Date(rule.lastRun).toLocaleString('ko-KR')}${rule.lastStatus === 'error' ? ' (오류 발생)' : ''}`
      : '';

    el.innerHTML = `
      <div class="rule-row">
        <div class="checkbox-field" style="padding-top:2px;">
          <input type="checkbox" class="rule-enabled" data-id="${rule.id}" ${rule.enabled ? 'checked' : ''}>
        </div>
        <div class="rule-info">
          <div class="rule-title">${freqLabel} · ${rule.time}</div>
          <div class="rule-sub">${target}${rule.backup ? ' · 실행 전 백업 다운로드' : ''}</div>
          <div class="rule-meta">${nextRunText}${lastRunText}</div>
        </div>
        <div class="rule-actions">
          <button class="run-now" data-id="${rule.id}">지금 실행</button>
          <button class="remove-rule" data-id="${rule.id}">삭제</button>
        </div>
      </div>`;
    container.appendChild(el);
  });

  document.querySelectorAll('.rule-enabled').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const rules = await loadRules();
      const r = rules.find((x) => x.id === cb.dataset.id);
      if (r) r.enabled = cb.checked;
      await saveRules(rules);
      await syncAlarms();
      renderRules();
    });
  });

  document.querySelectorAll('.remove-rule').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('이 예약을 삭제할까요?')) return;
      let rules = await loadRules();
      rules = rules.filter((x) => x.id !== btn.dataset.id);
      await saveRules(rules);
      await syncAlarms();
      renderRules();
    });
  });

  document.querySelectorAll('.run-now').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('지금 바로 이 규칙의 정리를 실행할까요? (예약 시각과 별개로 즉시 실행됩니다)')) return;
      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = '실행 중...';
      const res = await runRuleNow(btn.dataset.id);
      btn.disabled = false;
      btn.textContent = originalText;
      if (res && res.ok) {
        showStatus('ok', '정리를 실행했습니다.');
      } else {
        showStatus('err', `실행 실패: ${(res && res.error) || '알 수 없는 오류'}`);
      }
      renderRules();
    });
  });
}

// ---------------------------------------------------------------------------
// 예약 추가
// ---------------------------------------------------------------------------
document.getElementById('ruleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  showStatus('', '');

  const frequency = freqSelect.value;
  const time = document.getElementById('timeInput').value;
  if (!time) {
    showStatus('err', '실행 시각을 지정해주세요.');
    return;
  }

  const rule = {
    id: genId(),
    enabled: true,
    frequency,
    time,
    retentionDays: deleteAllToggle.checked ? 0 : Math.max(1, Number(retentionDays.value) || 30),
    backup: document.getElementById('ruleBackupToggle').checked,
    lastRun: null,
    lastStatus: null,
  };

  if (frequency === 'weekly') {
    rule.weekday = Number(weekdaySelect.value);
  } else if (frequency === 'once') {
    const dateVal = onceDate.value;
    if (!dateVal) {
      showStatus('err', '날짜를 선택해주세요.');
      return;
    }
    const candidate = new Date(`${dateVal}T${time}:00`);
    if (Number.isNaN(candidate.getTime()) || candidate.getTime() <= Date.now()) {
      showStatus('err', '이미 지난 시각입니다. 미래 날짜/시각을 선택해주세요.');
      return;
    }
    rule.date = dateVal;
  }

  const rules = await loadRules();
  rules.push(rule);
  await saveRules(rules);
  await syncAlarms();

  showStatus('ok', '예약이 추가되었습니다.');
  e.target.reset();
  document.getElementById('timeInput').value = '03:00';
  updateFormVisibility();
  renderRules();
});

document.getElementById('backBtn').addEventListener('click', () => {
  window.location.href = 'history.html';
});

renderRules();
