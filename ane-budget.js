// Daily API budget readout.
//
// Every OpenAlex response carries the remaining budget, and the fetch wrapper in
// ane-key.js already stores it in chrome.storage.local. This module just renders
// that stored value, so showing it costs no extra API calls.
//
// Renders into #aneBudget if the page provides it; otherwise does nothing.

(function () {
  'use strict';

  const AMBER_BELOW = 20; // percent
  const EL_ID = 'aneBudget';

  /**
   * Remaining budget as a percentage.
   *
   * OpenAlex bills a USD budget rather than a request count, so prefer the USD
   * headers and fall back to the request counters only when they are absent.
   * @returns {number|null} 0-100, or null if there is nothing meaningful to show
   */
  function toPercent(data) {
    if (!data) return null;
    if (data.limitUsd > 0) {
      return Math.max(0, Math.min(100, (data.remainingUsd / data.limitUsd) * 100));
    }
    if (data.limit > 0) {
      return Math.max(0, Math.min(100, (data.remaining / data.limit) * 100));
    }
    return null;
  }

  /** Whole numbers read as precise; show a decimal only in the last percent. */
  function formatPercent(pct) {
    if (pct === 0) return '0%';
    if (pct < 1) return '<1%';
    return `${Math.round(pct)}%`;
  }

  function colorFor(pct) {
    if (pct <= 0) return '#ff6b6b';
    if (pct < AMBER_BELOW) return '#f0a94e';
    return '#888';
  }

  function render(data) {
    const el = document.getElementById(EL_ID);
    if (!el) return;

    const pct = toPercent(data);
    if (pct === null) {
      // No API call made yet this session, so there is nothing to report.
      el.textContent = '';
      el.title = '';
      return;
    }

    el.textContent = `${formatPercent(pct)} left today`;
    el.style.color = colorFor(pct);
    el.title = pct <= 0
      ? 'Daily OpenAlex budget used up. It resets at midnight UTC.'
      : 'Share of your daily OpenAlex budget still available. Resets at midnight UTC.';
  }

  function refresh() {
    chrome.storage.local.get(['rateLimitData'], (result) => render(result.rateLimitData));
  }

  // Update live as requests come in and update the stored figure.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.rateLimitData) {
      render(changes.rateLimitData.newValue);
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refresh);
  } else {
    refresh();
  }
})();
