const backupToggle = document.getElementById('backupToggle');
const openBtn = document.getElementById('openBtn');

chrome.storage.local.get({ backupDefault: true }, (data) => {
  backupToggle.checked = !!data.backupDefault;
});

backupToggle.addEventListener('change', () => {
  chrome.storage.local.set({ backupDefault: backupToggle.checked });
});

openBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
  window.close();
});

document.getElementById('scheduleBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('scheduler.html') });
  window.close();
});
