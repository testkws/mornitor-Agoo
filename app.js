(() => {
  "use strict";

  const PAGE_SIZE = 50;
  const POLL_INTERVAL = 5 * 60_000;
  const HEARTBEAT_WINDOW = 10 * 60_000;
  const config = window.GOOGLE_MONITORING_CONFIG || {};
  const globalError = document.getElementById("global-error");
  const eventDetails = new Map();
  const attemptEvidence = new Map();
  const detailLoads = new Map();
  let client = null;
  let workers = [];
  let activeWorker = "";
  let activeView = "overview";
  let placesOffset = 0;
  let placesTotal = 0;
  let placeFilters = { query: "", outcome: "", queueStatus: "", review: null };
  let logsOffset = 0;
  let logsTotal = 0;
  let logFilters = { severity: "", from: "", to: "" };
  let detailPlace = null;
  let detailPlaceLoaded = false;
  let detailOpenerKey = null;
  let attemptsOffset = 0;
  let attemptsTotal = 0;
  let pollTimer = null;
  let manualRefresh = 0;
  let lastSuccessfulUpdate = null;
  // Ignore responses that belong to an older refresh or interaction.
  let workersRequest = 0;
  let viewRequest = 0;
  let detailRequest = 0;
  let statusRequest = 0;

  const el = (name, className, content) => {
    const node = document.createElement(name);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = String(content);
    return node;
  };

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  function formatDuration(startedAt, completedAt) {
    if (!startedAt || !completedAt) return "—";
    const elapsed = Date.parse(completedAt) - Date.parse(startedAt);
    if (!Number.isFinite(elapsed) || elapsed < 0) return "—";
    if (elapsed === 0) return "0 s";
    if (elapsed < 100) return "<0.1 s";
    const tenths = Math.round(elapsed / 100);
    const minutes = Math.floor(tenths / 600);
    const seconds = (tenths % 600) / 10;
    return `${minutes ? `${minutes} min ` : ""}${seconds} s`;
  }

  function formatCount(value) {
    return Number(value || 0).toLocaleString();
  }

  function setError(message = "") {
    globalError.classList.remove("warning");
    globalError.textContent = message;
    const hasData = document.getElementById(`${activeView}-view`).querySelector(".summary-grid, .table-wrap");
    const staleNote = document.getElementById("stale-note");
    if (!message) lastSuccessfulUpdate = new Date();
    staleNote.textContent = `Some displayed information may be out of date.${lastSuccessfulUpdate
      ? ` Last updated ${lastSuccessfulUpdate.toLocaleTimeString()}.` : ""} Use Refresh now to retry.`;
    staleNote.hidden = !message || !hasData;
    setLive(message ? "bad" : "ok", message ? "Update failed" : `Updated ${lastSuccessfulUpdate.toLocaleTimeString()}`);
  }

  function setWarning(message) {
    globalError.classList.add("warning");
    globalError.textContent = message;
    document.getElementById("stale-note").hidden = true;
    setLive("warning", "Partial update");
  }

  function setLive(state, text) {
    const live = document.getElementById("live-status");
    live.className = `live ${state}`;
    document.getElementById("live-text").textContent = text;
  }

  const PILL_TONES = {
    found: "ok", checked: "ok", info: "info", running: "info", pending: "neutral", debug: "neutral", skipped: "neutral",
    found_no_phone: "warn", ambiguous: "warn", retry_wait: "warn", warning: "warn",
    not_found: "bad", exhausted: "bad", blocked: "bad", failed: "bad", error: "bad",
  };

  function pill(value, label = value) {
    if (value == null || value === "" || value === "—") return "—";
    return { node: el("span", `pill ${PILL_TONES[value] || "neutral"}`, label) };
  }

  function resultOrThrow(result) {
    if (result.error) throw result.error;
    return result.data;
  }

  function makeTable(headers, rows, label, emptyMessage = "No records found.") {
    const wrapper = el("div", "table-wrap");
    wrapper.tabIndex = 0;
    wrapper.setAttribute("role", "region");
    wrapper.setAttribute("aria-label", label);
    const scrollHint = el("p", "table-scroll-hint", "Scroll sideways to see all columns.");
    scrollHint.setAttribute("aria-hidden", "true");
    const table = el("table");
    const thead = el("thead");
    const headRow = el("tr");
    headers.forEach((header) => {
      const cell = el("th", "", header);
      cell.scope = "col";
      headRow.append(cell);
    });
    thead.append(headRow);
    const tbody = el("tbody");
    rows.forEach((cells) => {
      const row = el("tr");
      cells.forEach((cell) => {
        const td = el("td", cell?.className || "");
        if (cell instanceof Node) td.append(cell);
        else if (cell && cell.node instanceof Node) td.append(cell.node);
        else td.textContent = cell?.text != null ? String(cell.text) : (cell == null ? "—" : String(cell));
        row.append(td);
      });
      tbody.append(row);
    });
    table.append(thead, tbody);
    wrapper.append(scrollHint, table);
    if (!rows.length) wrapper.append(el("p", "empty", emptyMessage));
    return wrapper;
  }

  function replaceTable(container, replacement) {
    const previous = container.querySelector(".table-wrap");
    const scrollLeft = previous?.scrollLeft || 0;
    const focused = previous?.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused && focused !== previous ? focused.dataset.focusKey : null;
    const openKeys = new Set(Array.from(previous?.querySelectorAll("details[open][data-detail-key]") || [],
      (detail) => detail.dataset.detailKey));
    replacement.querySelectorAll("details[data-detail-key]").forEach((detail) => {
      detail.open = openKeys.has(detail.dataset.detailKey);
    });
    container.replaceChildren(replacement);
    replacement.scrollLeft = scrollLeft;
    if (focused) {
      const target = focusKey && Array.from(replacement.querySelectorAll("[data-focus-key]"))
        .find((element) => element.dataset.focusKey === focusKey);
      (target || replacement).focus({ preventScroll: true });
      replacement.scrollLeft = scrollLeft;
    }
  }

  function setPager(prefix, offset, total, onPrevious, onNext) {
    const page = Math.floor(offset / PAGE_SIZE) + 1;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const pageLabel = document.getElementById(`${prefix}-page`);
    const description = `Page ${page} of ${pages} · ${formatCount(total)} rows`;
    if (pageLabel.textContent !== description) pageLabel.textContent = description;
    const previous = document.getElementById(`${prefix}-prev`);
    const next = document.getElementById(`${prefix}-next`);
    previous.disabled = offset <= 0;
    next.disabled = offset + PAGE_SIZE >= total;
    previous.onclick = onPrevious;
    next.onclick = onNext;
  }

  function workerLabel(worker) {
    return worker.display_name || worker.worker_id;
  }

  function syncWorkerPicker(picker) {
    if (picker.value !== activeWorker) picker.value = activeWorker;
    const title = picker.selectedOptions[0]?.textContent || "All workers";
    if (picker.title !== title) picker.title = title;
  }

  function populateWorkers() {
    const active = document.getElementById("active-worker");
    const logWorker = document.getElementById("log-worker");
    const options = [{ value: "", label: "All workers" }, ...workers.map((worker) => ({
      value: worker.worker_id,
      label: `${workerLabel(worker)} · ${worker.worker_id.slice(0, 8)}`,
    }))];
    [active, logWorker].forEach((picker) => {
      const unchanged = picker.options.length === options.length && options.every((option, index) =>
        picker.options[index].value === option.value && picker.options[index].textContent === option.label);
      if (!unchanged) {
        const fragment = document.createDocumentFragment();
        options.forEach(({ value, label }) => {
          const option = el("option", "", label);
          option.value = value;
          fragment.append(option);
        });
        picker.replaceChildren(fragment);
      }
      syncWorkerPicker(picker);
    });
  }

  function setActiveWorker(workerId) {
    if (activeWorker !== workerId) {
      activeWorker = workerId;
      placesOffset = 0;
      logsOffset = 0;
      viewRequest += 1;
      detailRequest += 1;
    }
    syncWorkerPicker(document.getElementById("active-worker"));
    syncWorkerPicker(document.getElementById("log-worker"));
  }

  async function countAttempts(workerId, windowStart, windowEnd, filter) {
    try {
      let query = client.from("monitoring_attempts")
        .select("attempt_id", { count: "exact", head: true })
        .gte("worker_completed_at", windowStart)
        .lte("worker_completed_at", windowEnd);
      if (workerId) query = query.eq("worker_id", workerId);
      if (filter === "matched") query = query.in("outcome", ["found", "found_no_phone"]);
      if (filter === "blocked") query = query.eq("error_code", "BLOCKED");
      if (filter === "consent") query = query.eq("error_code", "CONSENT_REQUIRED");
      if (filter === "retry") query = query.eq("status", "retry_wait").eq("outcome", "lookup_error");
      const result = await query;
      return !result.error && Number.isInteger(result.count) && result.count >= 0 ? result.count : null;
    } catch {
      return null;
    }
  }

  async function fetchAttemptSummary(workerId, isCurrent) {
    const end = Date.now();
    const start = new Date(end - 24 * 60 * 60 * 1000).toISOString();
    const until = new Date(end).toISOString();
    const [matched, blocked, consent, retry] = await Promise.all(
      ["matched", "blocked", "consent", "retry"].map((filter) => countAttempts(workerId, start, until, filter)),
    );
    if (!isCurrent()) return null;
    // Count the denominator last so newly uploaded historical attempts do not inflate rates.
    const total = await countAttempts(workerId, start, until, "total");
    if (!isCurrent()) return null;
    const summary = { matched, blocked, consent, retry, total };
    if (total !== null) {
      for (const key of ["matched", "blocked", "consent", "retry"]) {
        if (summary[key] !== null && summary[key] > total) summary[key] = null;
      }
    }
    return summary;
  }

  function rate(numerator, denominator) {
    if (numerator === null || denominator === null) return { value: "—", detail: "Count unavailable" };
    if (!denominator) return { value: "—", detail: "No completed attempts" };
    return {
      value: `${(numerator * 100 / denominator).toFixed(1)}%`,
      detail: `${formatCount(numerator)} of ${formatCount(denominator)} attempts`,
      percent: numerator * 100 / denominator,
    };
  }

  function summaryCard(key, label, value, subvalue, detail, symbol, tone, percent) {
    const card = el("article", `summary-card ${tone}`);
    card.dataset.metric = key;
    const header = el("div", "summary-card-head");
    const icon = el("span", "summary-icon", symbol);
    icon.setAttribute("aria-hidden", "true");
    header.append(el("h3", "summary-label", label), icon);
    card.append(header, el("div", "summary-value", value), el("p", "summary-subvalue", subvalue));
    if (percent !== undefined) {
      const meter = el("div", "summary-meter");
      meter.setAttribute("aria-hidden", "true");
      const fill = el("span");
      fill.style.width = `${percent}%`;
      meter.append(fill);
      card.append(meter);
    }
    card.append(el("p", "summary-detail", detail));
    return card;
  }

  function attemptChart(attempts) {
    const section = el("section", "chart-panel");
    section.dataset.chart = "attempts";
    const title = el("h3", "chart-title", "Attempt results");
    title.id = "attempt-chart-title";
    section.setAttribute("aria-labelledby", title.id);
    section.append(title, el("p", "chart-description", "Completed attempts · last 24 hours"));

    if (attempts.matched === null || attempts.total === null) {
      section.append(el("p", "chart-empty", "Attempt counts are unavailable. Retrying automatically."));
      return section;
    }
    if (!attempts.total) {
      section.append(el("p", "chart-empty", "No completed attempts in the last 24 hours."));
      return section;
    }

    const matched = attempts.matched;
    const other = attempts.total - matched;
    const layout = el("div", "chart-donut-layout");
    const donut = el("div", "chart-donut");
    donut.style.setProperty("--matched-share", `${matched * 100 / attempts.total}%`);
    const center = el("div", "chart-donut-center");
    center.append(el("strong", "", formatCount(attempts.total)), el("span", "", "completed"));
    donut.append(center);

    const legend = el("ul", "chart-legend");
    [
      { key: "matched", label: "Matched", count: matched },
      { key: "other", label: "Other results", count: other },
    ].forEach(({ key, label, count }) => {
      const item = el("li", "chart-legend-item");
      item.dataset.result = key;
      const marker = el("span", `chart-legend-marker ${key}`);
      marker.setAttribute("aria-hidden", "true");
      const text = el("div", "chart-legend-text");
      text.append(el("span", "chart-legend-label", label),
        el("span", "chart-legend-value", `${formatCount(count)} · ${(count * 100 / attempts.total).toFixed(1)}%`));
      item.append(marker, text);
      legend.append(item);
    });
    layout.append(donut, legend);
    section.append(layout, el("p", "chart-note", "Matches include results with or without a phone number."));
    return section;
  }

  function queueChart(pending, scheduled, running) {
    const section = el("section", "chart-panel");
    section.dataset.chart = "queue";
    const title = el("h3", "chart-title", "Queue snapshot");
    title.id = "queue-chart-title";
    section.setAttribute("aria-labelledby", title.id);
    section.append(title, el("p", "chart-description", "Latest uploaded counts · scaled to the largest group"));

    const rows = [
      { key: "pending", label: "Pending", count: pending },
      { key: "scheduled", label: "Scheduled", count: scheduled },
      { key: "running", label: "Running", count: running },
    ];
    const maximum = Math.max(...rows.map((row) => row.count));
    const list = el("ul", "chart-bars");
    rows.forEach(({ key, label, count }) => {
      const item = el("li", "chart-bar-item");
      item.dataset.status = key;
      const heading = el("div", "chart-bar-heading");
      heading.append(el("span", "", label), el("strong", "", formatCount(count)));
      const track = el("div", "chart-bar-track");
      track.setAttribute("aria-hidden", "true");
      const fill = el("span", "chart-bar-fill");
      fill.style.width = `${maximum ? count * 100 / maximum : 0}%`;
      track.append(fill);
      item.append(heading, track);
      list.append(item);
    });
    section.append(list, el("p", "chart-note", "Scheduled includes future rechecks."));
    return section;
  }

  function workerStat(label, value, detail) {
    const stat = el("div", "worker-stat");
    stat.append(el("div", "worker-stat-label", label), el("div", "worker-stat-value", value));
    if (detail) stat.append(el("div", "worker-stat-detail", detail));
    return stat;
  }

  function heartbeatRecent(worker, now) {
    const received = worker.last_heartbeat_at ? new Date(worker.last_heartbeat_at).getTime() : NaN;
    const age = now - received;
    return Number.isFinite(age) && age >= 0 && age < HEARTBEAT_WINDOW;
  }

  async function renderOverview(isCurrent) {
    const container = document.getElementById("overview-view");
    const workerId = activeWorker;
    const [result, attempts] = await Promise.all([
      client.rpc("monitoring_overview", { p_worker_id: workerId || null }),
      fetchAttemptSummary(workerId, isCurrent),
    ]);
    if (!isCurrent() || !attempts) return "";
    const data = resultOrThrow(result);
    if (!Array.isArray(data?.workers)) throw new Error("Worker data is unavailable.");
    workers = data.workers;
    if (workerId && !workers.some((worker) => worker.worker_id === workerId)) {
      setActiveWorker("");
      populateWorkers();
      await refreshCurrent();
      return "";
    }
    populateWorkers();
    const chosenWorkers = workerId ? workers.filter((worker) => worker.worker_id === workerId) : workers;
    const now = Date.now();
    const reporting = chosenWorkers.filter((worker) => heartbeatRecent(worker, now)).length;
    const paused = chosenWorkers.filter((worker) => worker.current_state?.pause_reason).length;
    const counts = data.queue_counts || {};
    const pending = Number(counts.pending || 0);
    const scheduled = Number(counts.retry_wait || 0);
    const running = Number(counts.running || 0);
    const successRate = rate(attempts.matched, attempts.total);
    const retryRate = rate(attempts.retry, attempts.total);
    const unavailable = Object.values(attempts).some((value) => value === null);

    const content = document.createDocumentFragment();
    const heading = el("div", "overview-heading");
    const intro = el("div");
    intro.append(el("p", "eyebrow", "Monitoring / Overview"), el("h2", "overview-title", "Operations at a glance"),
      el("p", "overview-description", "Performance, queue health, and worker activity in one place."));
    const period = el("div", "period-label", "Last 24 hours");
    heading.append(intro, period);
    content.append(heading);

    const summary = el("div", "summary-grid");
    summary.append(
      summaryCard("success", "Success rate", successRate.value, successRate.detail, "Matched, with or without a phone", "✓", "success", successRate.percent),
      summaryCard("blocked", "CAPTCHA / blocks", attempts.blocked === null ? "—" : formatCount(attempts.blocked),
        attempts.blocked === null ? "Count unavailable" : "Blocked lookup attempts",
        attempts.consent === null ? "Consent count unavailable" : `${formatCount(attempts.consent)} consent required`, "!", "danger"),
      summaryCard("retry", "Retry rate", retryRate.value, retryRate.detail, "Scheduled after a temporary error", "↻", "warning", retryRate.percent),
      summaryCard("queue", "Pending queue", formatCount(pending + scheduled),
        `${formatCount(pending)} pending · ${formatCount(scheduled)} scheduled`,
        `${formatCount(running)} running · includes future rechecks`, "≡", "info"),
      summaryCard("workers", "Worker status", chosenWorkers.length ? `${formatCount(reporting)} / ${formatCount(chosenWorkers.length)}` : "—",
        chosenWorkers.length ? "Recent heartbeats received" : "No workers provisioned",
        chosenWorkers.length ? `${formatCount(chosenWorkers.length - reporting)} without a recent heartbeat · ${formatCount(paused)} last reported paused` : "Waiting for worker data", "◉", "accent"),
    );
    content.append(summary);
    content.append(el("p", "summary-note", "Performance uses completed attempts in the last 24 hours. Queue and worker status reflect the latest uploaded snapshots."));

    const chartHeading = el("div", "activity-section-heading");
    chartHeading.append(el("p", "eyebrow", "At a glance"), el("h2", "activity-section-title", "Activity breakdown"));
    const charts = el("div", "charts-grid");
    charts.append(attemptChart(attempts), queueChart(pending, scheduled, running));
    content.append(chartHeading, charts);

    const workerHeading = el("div", "worker-section-heading");
    const workerIntro = el("div");
    workerIntro.append(el("p", "eyebrow", "Fleet activity"), el("h2", "worker-section-title", "Workers"));
    workerHeading.append(workerIntro, el("p", "worker-section-note", "Heartbeat received within the last 10 minutes"));
    content.append(workerHeading);

    if (!chosenWorkers.length) content.append(el("p", "empty panel", "No scraper worker is provisioned yet."));
    chosenWorkers.forEach((worker) => {
      const state = worker.current_state || {};
      const recent = heartbeatRecent(worker, now);
      const runStatus = recent ? "Heartbeat recent" : "Worker not reporting";
      const runBadge = el("span", `badge${recent ? "" : " warning"}`, runStatus);
      const section = el("section", "worker-panel");
      const header = el("div", "worker-head");
      const identity = el("div", "worker-identity");
      const avatar = el("span", "worker-avatar", workerLabel(worker).slice(0, 1).toUpperCase());
      avatar.setAttribute("aria-hidden", "true");
      const identityText = el("div");
      identityText.append(el("h3", "worker-name", workerLabel(worker)), el("p", "worker-id", `Worker ID ${worker.worker_id}`));
      identity.append(avatar, identityText);
      const badges = el("div", "worker-badges");
      badges.append(runBadge);
      if (state.pause_reason) badges.append(el("span", "badge error", `Last reported paused: ${state.pause_reason}`));
      else if (state.state_event_type === "queue_resumed") badges.append(el("span", "badge", "Queue resumed"));
      else if (state.state_event_type === "run_ended") badges.append(el("span", "badge", "Runner stopped"));
      header.append(identity, badges);
      section.append(header);

      const usage = state.daily_usage != null ? `${formatCount(state.daily_usage)} / ${state.daily_limit == null ? "—" : formatCount(state.daily_limit)}` : "—";
      const day = state.bangkok_day ? `Bangkok day ${state.bangkok_day}` : "No usage reported yet";
      const current = state.current_job ? `${state.current_job.name || "Unnamed place"} · ${state.current_job.osm_id || "—"}` : "No lookup reported";
      const exit = worker.last_exit ? `${worker.last_exit.outcome || "exit reported"}${worker.last_exit.reason ? ` · ${worker.last_exit.reason}` : ""}` : "No run exit reported yet";
      const queue = state.queue_counts || {};
      const queueLine = Object.entries(queue).map(([name, count]) => `${name}: ${formatCount(count)}`).join(" · ") || "No queue counts reported yet";
      const stats = el("div", "worker-stats");
      stats.append(
        workerStat("Daily usage / limit", usage, day),
        workerStat("Last reported lookup", current, `Pending uploads: ${state.pending_upload_count == null ? "—" : formatCount(state.pending_upload_count)}`),
        workerStat("Last heartbeat", formatDate(worker.last_heartbeat_at), recent ? "Received within 10 minutes" : "No recent heartbeat received"),
        workerStat("Last upload", formatDate(worker.last_upload_at), `Last seen ${formatDate(worker.last_seen_at)}`),
      );
      section.append(stats);
      const detail = el("div", "worker-meta");
      const lastExit = worker.last_exit || {};
      const safety = Number(lastExit.safety_sequence || 0) > Number(state.safety_sequence || state.state_sequence || 0)
        ? lastExit.safety : state.safety;
      const recentErrors = safety && safety.recent_temporary_errors != null && safety.recent_attempts != null
        ? `${formatCount(safety.recent_temporary_errors)} / ${formatCount(safety.recent_attempts)} recent attempts · ${formatCount(safety.consecutive_temporary_errors)} consecutive`
        : "Not reported yet";
      detail.append(el("span", "", `Queue: ${queueLine}`), el("span", "", `Last reported exit: ${exit}`),
        el("span", "", `Temporary errors: ${recentErrors}`));
      section.append(detail);
      content.append(section);
    });
    container.replaceChildren(content);
    return unavailable ? "Some performance metrics are unavailable. Retrying automatically." : "";
  }

  function selectedReview() {
    const value = document.getElementById("place-review").value;
    return value === "" ? null : value === "true";
  }

  function applyPlaceFilters() {
    placeFilters = {
      query: document.getElementById("place-query").value.trim(),
      outcome: document.getElementById("place-outcome").value,
      queueStatus: document.getElementById("place-status").value,
      review: selectedReview(),
    };
    placesOffset = 0;
    refreshCurrent();
  }

  function setLogDateError(message) {
    const error = document.getElementById("log-date-error");
    error.textContent = message;
    error.hidden = !message;
    ["log-from", "log-to"].forEach((id) => {
      const field = document.getElementById(id);
      if (message) field.setAttribute("aria-invalid", "true");
      else field.removeAttribute("aria-invalid");
    });
  }

  function applyLogFilters() {
    const from = document.getElementById("log-from").value;
    const to = document.getElementById("log-to").value;
    const fromTime = from ? new Date(from).getTime() : null;
    const toTime = to ? new Date(to).getTime() : null;
    if ((from && !Number.isFinite(fromTime)) || (to && !Number.isFinite(toTime))) {
      setLogDateError("Enter valid start and end dates.");
      return;
    }
    if (fromTime !== null && toTime !== null && fromTime > toTime) {
      setLogDateError("From must be on or before To.");
      return;
    }
    setLogDateError("");
    logFilters = {
      severity: document.getElementById("log-severity").value,
      from: fromTime === null ? "" : new Date(fromTime).toISOString(),
      to: toTime === null ? "" : new Date(toTime).toISOString(),
    };
    logsOffset = 0;
    refreshCurrent();
  }

  async function renderPlaces(isCurrent) {
    const { query, outcome, queueStatus, review } = placeFilters;
    const params = {
      p_query: query,
      p_outcome: outcome,
      p_queue_status: queueStatus,
      p_worker_id: activeWorker || null,
      p_review_flag: review,
      p_limit: PAGE_SIZE,
    };
    // The RPC's SQL ILIKE accepts wildcards and PostgREST has its own filter
    // grammar. Preserve the original search behavior for anything outside this
    // conservative set of ordinary search characters.
    const search = Array.from(query).slice(0, 200).join("");
    const useRpc = !/^[\p{L}\p{M}\p{N}\s/-]*$/u.test(search);
    const fetchPage = async (offset) => {
      if (useRpc) return client.rpc("monitoring_places_page", { ...params, p_offset: offset });
      let request = client.from("monitoring_place_results")
        .select("worker_id,osm_id,name:source_record->>name,outcome,queue_status,review_flag,latest_error_code", { count: "exact" })
        .order("osm_id", { ascending: true })
        .order("worker_id", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      if (params.p_worker_id) request = request.eq("worker_id", params.p_worker_id);
      if (outcome) request = request.eq("outcome", outcome);
      if (queueStatus) request = request.eq("queue_status", queueStatus);
      if (review !== null) request = request.eq("review_flag", review);
      if (search) request = request.or(`osm_id.ilike.*${search}*,source_record->>name.ilike.*${search}*`);
      const result = await request;
      if (result.error) return result;
      return { data: { total: result.count, rows: (result.data || []).map((place) => ({
        ...place, source_record: { name: place.name },
      })) }, error: null };
    };
    let offset = placesOffset;
    let result = await fetchPage(offset);
    if (!isCurrent()) return;
    let data = resultOrThrow(result);
    if (offset > 0 && offset >= Number(data.total || 0)) {
      offset = 0;
      result = await fetchPage(offset);
      if (!isCurrent()) return;
      data = resultOrThrow(result);
    }
    placesOffset = offset;
    placesTotal = Number(data.total || 0);
    const rows = (data.rows || []).map((place) => {
      const name = place.source_record?.name || "(unnamed)";
      const button = el("button", "link", name);
      button.type = "button";
      button.dataset.focusKey = JSON.stringify([place.worker_id, place.osm_id]);
      button.addEventListener("click", () => openDetail(place));
      return [button, place.worker_id.slice(0, 8), place.osm_id, pill(place.outcome), pill(place.queue_status), place.review_flag ? pill("warning", "needs review") : "—", place.latest_error_code || "—"];
    });
    const filtered = query || outcome || queueStatus || review !== null || activeWorker;
    const emptyMessage = filtered
      ? "No places match the current filters. Adjust the filters or worker selection and try again."
      : "No places have been reported yet.";
    replaceTable(document.getElementById("places-table"), makeTable(
      ["Name", "Worker", "OSM ID", "Outcome", "Queue", "Review", "Latest error"], rows, "Places table", emptyMessage,
    ));
    setPager("places", offset, placesTotal,
      () => { placesOffset = Math.max(0, offset - PAGE_SIZE); refreshCurrent(); },
      () => { placesOffset = offset + PAGE_SIZE; refreshCurrent(); });
  }

  function openDetail(place) {
    detailRequest += 1;
    detailPlace = place;
    detailPlaceLoaded = false;
    detailOpenerKey = JSON.stringify([place.worker_id, place.osm_id]);
    attemptsOffset = 0;
    document.getElementById("detail-title").textContent = `${place.source_record?.name || "Place"} · ${place.osm_id}`;
    document.getElementById("detail-error").textContent = "";
    const retry = document.getElementById("detail-retry");
    retry.hidden = true;
    retry.disabled = false;
    const loading = el("p", "muted detail-loading", "Loading place details…");
    loading.setAttribute("role", "status");
    document.getElementById("detail-content").replaceChildren(loading);
    document.getElementById("attempts-table").replaceChildren();
    document.getElementById("attempts-page").textContent = "Loading…";
    document.getElementById("attempts-prev").disabled = true;
    document.getElementById("attempts-next").disabled = true;
    const dialog = document.getElementById("place-dialog");
    if (!dialog.open) dialog.showModal();
    refreshDetail();
  }

  function detailPanel(title, value) {
    const column = el("div", "detail-column");
    column.append(el("h3", "", title));
    const pre = el("pre");
    pre.textContent = JSON.stringify(value ?? {}, null, 2);
    column.append(pre);
    return column;
  }

  async function refreshDetail(options = {}) {
    const dialog = document.getElementById("place-dialog");
    if (!detailPlace || !dialog.open || document.hidden) return false;
    const request = ++detailRequest;
    const attemptContainer = document.getElementById("attempts-table");
    const retry = document.getElementById("detail-retry");
    const retryHadFocus = document.activeElement === retry;
    if (!retry.hidden) retry.disabled = true;
    attemptContainer.setAttribute("aria-busy", "true");
    const status = options.status ?? ++statusRequest;
    const originalPlace = detailPlace;
    const isCurrent = () => request === detailRequest && !document.hidden && dialog.open &&
      detailPlace?.worker_id === originalPlace.worker_id && detailPlace?.osm_id === originalPlace.osm_id &&
      (!options.isViewCurrent || options.isViewCurrent());
    let place = originalPlace;
    let offset = attemptsOffset;

    try {
      if (options.refreshPlace || !detailPlaceLoaded) {
        const latest = await client.from("monitoring_place_results")
          .select("worker_id,osm_id,source_record,google_proposal,candidates,matching_method,similarity,distance_m,review_flag,latest_error_code,latest_error_message")
          .eq("worker_id", place.worker_id).eq("osm_id", place.osm_id).maybeSingle();
        if (!isCurrent()) return false;
        place = resultOrThrow(latest);
        if (!place) throw new Error("Place details are no longer available.");
        detailPlace = place;
        detailPlaceLoaded = true;
      }

      const fetchPage = (pageOffset) => client.from("monitoring_attempts")
        .select("attempt_id,status,outcome,matching_method,error_code,error_message,worker_started_at,worker_completed_at", { count: "exact" })
        .eq("worker_id", place.worker_id)
        .eq("osm_id", place.osm_id)
        .order("worker_completed_at", { ascending: false })
        .order("attempt_id", { ascending: false })
        .range(pageOffset, pageOffset + PAGE_SIZE - 1);
      let result = await fetchPage(offset);
      if (!isCurrent()) return false;
      let attempts = resultOrThrow(result) || [];
      if (offset > 0 && offset >= Number(result.count || 0)) {
        offset = 0;
        result = await fetchPage(offset);
        if (!isCurrent()) return false;
        attempts = resultOrThrow(result) || [];
      }

      const pendingReview = place.google_proposal?.review_status === "pending" &&
        place.google_proposal?.selection_method === "nearest_suggestion";
      const reviewed = place.google_proposal?.selection_method === "nearest_reviewed";
      const columns = el("div", "detail-columns");
      columns.append(
        detailPanel("OSM source fields", place.source_record),
        detailPanel(pendingReview ? "Suggested nearest match — awaiting review" :
          reviewed ? "Reviewed nearest Google match" : "Latest successful Google proposal", place.google_proposal),
      );
      const content = document.createDocumentFragment();
      if (pendingReview) content.append(el("p", "muted", "This suggestion is excluded from exports until approved on the scraper server. Use review list to find its ID."));
      content.append(columns, detailPanel("Latest candidates", place.candidates));
      content.append(el("p", "muted", `Matching: ${place.matching_method || "—"} · Similarity: ${place.similarity ?? "—"} · Distance: ${place.distance_m ?? "—"} m · Review flag: ${place.review_flag ? "Yes" : "No"}`));
      if (place.latest_error_code || place.latest_error_message) {
        const error = el("div", "panel");
        error.append(el("strong", "", `Latest error ${place.latest_error_code || ""}`));
        error.append(el("p", "", place.latest_error_message || ""));
        content.append(error);
      }
      const rows = attempts.map((attempt) => [
        formatDate(attempt.worker_completed_at), formatDuration(attempt.worker_started_at, attempt.worker_completed_at),
        pill(attempt.status), pill(attempt.outcome),
        attempt.matching_method || "—", attempt.error_code || attempt.error_message || "—",
        { node: makeDisclosure(attempt, place.worker_id), className: "wrap" },
      ]);
      detailPlace = place;
      attemptsOffset = offset;
      attemptsTotal = Number(result.count || 0);
      document.getElementById("detail-error").textContent = "";
      if (retryHadFocus && (document.activeElement === retry || document.activeElement === dialog ||
          !dialog.contains(document.activeElement))) {
        document.getElementById("detail-close").focus({ preventScroll: true });
      }
      retry.hidden = true;
      document.getElementById("detail-content").replaceChildren(content);
      replaceTable(document.getElementById("attempts-table"), makeTable(
        ["Completed", "Duration", "Status", "Outcome", "Match", "Latest error", "Evidence"], rows,
        "Attempt history table", "No attempts have been reported for this place yet.",
      ));
      setPager("attempts", offset, attemptsTotal,
        () => { attemptsOffset = Math.max(0, offset - PAGE_SIZE); refreshDetail(); },
        () => { attemptsOffset = offset + PAGE_SIZE; refreshDetail(); });
      if (options.status === undefined && status === statusRequest) setError("");
      return true;
    } catch (error) {
      if (isCurrent()) {
        const message = error?.message || "Unable to load place details.";
        document.getElementById("detail-error").textContent = message;
        retry.hidden = false;
        const loading = document.querySelector("#detail-content .detail-loading");
        if (loading) {
          loading.textContent = "Unable to load place details. Try again.";
          document.getElementById("attempts-page").textContent = "Unavailable";
        }
        if (status === statusRequest) setError(message);
      }
      return false;
    } finally {
      if (request === detailRequest) {
        attemptContainer.removeAttribute("aria-busy");
        retry.disabled = false;
      }
    }
  }

  function lazyDisclosure({ key, loadKey, label, cache, load, format }) {
    const details = el("details");
    details.dataset.detailKey = key;
    const summary = el("summary", "", "View");
    summary.dataset.focusKey = key;
    summary.setAttribute("aria-label", label);
    const content = el("div", "disclosure-content");
    details.append(summary, content);

    const show = async () => {
      if (!details.open) return;
      if (cache.has(key)) {
        const pre = el("pre");
        pre.textContent = JSON.stringify(format(cache.get(key)), null, 2);
        content.replaceChildren(pre);
        content.removeAttribute("aria-busy");
        return;
      }
      const loading = el("p", "muted", "Loading details…");
      loading.setAttribute("role", "status");
      content.replaceChildren(loading);
      content.setAttribute("aria-busy", "true");
      let pending = detailLoads.get(loadKey);
      if (!pending) {
        pending = Promise.resolve().then(load).then((value) => {
          cache.set(key, value);
          return value;
        }).finally(() => detailLoads.delete(loadKey));
        detailLoads.set(loadKey, pending);
      }
      try {
        await pending;
        if (details.isConnected && details.open) await show();
      } catch (error) {
        if (!details.isConnected || !details.open) return;
        content.removeAttribute("aria-busy");
        const message = el("p", "field-error", error?.message || "Unable to load details.");
        message.setAttribute("role", "alert");
        const retry = el("button", "secondary", "Retry loading details");
        retry.type = "button";
        retry.addEventListener("click", () => {
          summary.focus({ preventScroll: true });
          show();
        });
        content.replaceChildren(message, retry);
      }
    };
    details.addEventListener("toggle", () => { if (details.open) show(); });
    return details;
  }

  function makeDisclosure(attempt, workerId) {
    const key = JSON.stringify([workerId, attempt.attempt_id]);
    return lazyDisclosure({
      key, loadKey: `attempt:${key}`, cache: attemptEvidence,
      label: `View evidence for attempt completed ${formatDate(attempt.worker_completed_at)}`,
      load: async () => {
        const result = await client.from("monitoring_attempts").select("candidates,proposal,errors")
          .eq("worker_id", workerId).eq("attempt_id", attempt.attempt_id).maybeSingle();
        const evidence = resultOrThrow(result);
        if (!evidence) throw new Error("Attempt evidence is no longer available.");
        return evidence;
      },
      format: (evidence) => ({
        started_at: attempt.worker_started_at, completed_at: attempt.worker_completed_at,
        candidates: evidence.candidates, proposal: evidence.proposal, errors: evidence.errors,
      }),
    });
  }

  async function renderLogs(isCurrent) {
    const workerId = document.getElementById("log-worker").value;
    const { severity, from: fromTime, to: toTime } = logFilters;
    const fetchPage = (offset) => {
      let query = client.from("monitoring_operational_events")
        .select("event_id,worker_id,run_id,event_type,severity,received_at", { count: "exact" })
        .order("received_at", { ascending: false })
        .order("event_id", { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);
      if (workerId) query = query.eq("worker_id", workerId);
      if (severity) query = query.eq("severity", severity);
      if (fromTime) query = query.gte("received_at", fromTime);
      if (toTime) query = query.lte("received_at", toTime);
      return query;
    };
    let offset = logsOffset;
    let result = await fetchPage(offset);
    if (!isCurrent()) return;
    let events = resultOrThrow(result) || [];
    if (offset > 0 && offset >= Number(result.count || 0)) {
      offset = 0;
      result = await fetchPage(offset);
      if (!isCurrent()) return;
      events = resultOrThrow(result) || [];
    }
    logsOffset = offset;
    logsTotal = Number(result.count || 0);
    const rows = events.map((event) => [
      formatDate(event.received_at), pill(event.severity), event.event_type,
      event.worker_id.slice(0, 8), event.run_id || "—",
      { node: jsonDisclosure(event), className: "wrap" },
    ]);
    const filtered = workerId || severity || fromTime || toTime;
    const emptyMessage = filtered
      ? "No events match the current filters. Adjust the filters or worker selection and try again."
      : "No operational events have been received yet.";
    replaceTable(document.getElementById("logs-table"), makeTable(
      ["Received", "Severity", "Event", "Worker", "Run", "Details"], rows, "Operational logs table", emptyMessage,
    ));
    setPager("logs", offset, logsTotal,
      () => { logsOffset = Math.max(0, offset - PAGE_SIZE); refreshCurrent(); },
      () => { logsOffset = offset + PAGE_SIZE; refreshCurrent(); });
  }

  function jsonDisclosure(event) {
    const key = event.event_id;
    return lazyDisclosure({
      key, loadKey: `event:${key}`, cache: eventDetails,
      label: `View details for ${event.event_type} received ${formatDate(event.received_at)}`,
      load: async () => {
        const result = await client.from("monitoring_operational_events").select("data")
          .eq("event_id", key).maybeSingle();
        const row = resultOrThrow(result);
        if (!row) throw new Error("Log details are no longer available.");
        return row.data ?? {};
      },
      format: (data) => data,
    });
  }

  async function refreshCurrent() {
    const request = ++viewRequest;
    if (document.hidden || !client) return;
    const view = activeView;
    const section = document.getElementById(`${view}-view`);
    section.setAttribute("aria-busy", "true");
    const placeholder = section.querySelector(".view-placeholder");
    if (placeholder) placeholder.textContent = `Loading ${view}…`;
    setLive("", "Updating…");
    const status = ++statusRequest;
    const isCurrent = () => request === viewRequest && !document.hidden && activeView === view;
    try {
      let warning = "";
      if (view === "overview") warning = await renderOverview(isCurrent);
      else if (view === "places") {
        await renderPlaces(isCurrent);
        if (!isCurrent()) return;
        if (detailPlace && document.getElementById("place-dialog").open) {
          const updated = await refreshDetail({ refreshPlace: true, isViewCurrent: isCurrent, status });
          if (!updated) return;
        }
      }
      else await renderLogs(isCurrent);
      if (isCurrent() && status === statusRequest) {
        if (warning) setWarning(warning);
        else setError("");
      }
    } catch (error) {
      if (isCurrent() && status === statusRequest) {
        if (placeholder) placeholder.textContent = `Unable to load ${view}. Select Refresh now to try again.`;
        setError(error?.message || "Unable to load monitoring data.");
      }
    } finally {
      if (request === viewRequest) section.removeAttribute("aria-busy");
    }
  }

  async function refreshWorkers(isCurrent) {
    const result = await client.from("monitoring_workers")
      .select("worker_id,display_name,created_at,last_seen_at,last_upload_at,last_heartbeat_at,current_state,last_exit,last_event_sequence")
      .order("display_name");
    if (!isCurrent()) return false;
    workers = resultOrThrow(result) || [];
    if (activeWorker && !workers.some((worker) => worker.worker_id === activeWorker)) setActiveWorker("");
    populateWorkers();
    return true;
  }

  async function refreshAll() {
    const request = ++workersRequest;
    if (document.hidden || !client) return;
    const view = activeView;
    const status = ++statusRequest;
    const isCurrent = () => request === workersRequest && !document.hidden && activeView === view;
    setLive("", "Updating…");
    try {
      if (view === "overview" || await refreshWorkers(isCurrent)) await refreshCurrent();
    } catch (error) {
      if (isCurrent() && status === statusRequest) {
        const placeholder = document.querySelector(`#${activeView}-view .view-placeholder`);
        if (placeholder) placeholder.textContent = `Unable to load ${activeView}. Select Refresh now to try again.`;
        setError(error?.message || "Unable to refresh data.");
      }
    }
  }

  function startApp() {
    refreshAll();
    startPolling();
  }

  function startPolling() {
    stopPolling();
    if (!document.hidden) pollTimer = window.setInterval(refreshAll, POLL_INTERVAL);
  }

  function stopPolling() {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = null;
  }

  function switchView(view) {
    document.getElementById(`${activeView}-view`).removeAttribute("aria-busy");
    activeView = view;
    workersRequest += 1;
    detailRequest += 1;
    document.querySelectorAll(".tab").forEach((button) => {
      const selected = button.dataset.view === view;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    document.querySelectorAll(".view").forEach((section) => { section.hidden = section.id !== `${view}-view`; });
    refreshCurrent();
  }

  document.getElementById("refresh").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.classList.remove("spin");
    void button.offsetWidth;
    button.classList.add("spin");
    if (!client || document.hidden) return;
    const request = ++manualRefresh;
    const announcement = document.getElementById("refresh-announcement");
    announcement.textContent = "Refreshing dashboard…";
    await refreshAll();
    if (request !== manualRefresh || document.hidden) return;
    const live = document.getElementById("live-status");
    announcement.textContent = live.classList.contains("ok") ? "Dashboard updated."
      : live.classList.contains("warning") ? "Dashboard updated with some metrics unavailable." : "";
  });
  const themeToggle = document.getElementById("theme-toggle");
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  function isDarkTheme() {
    const selected = document.documentElement.dataset.theme;
    return selected === "dark" || (selected !== "light" && systemTheme.matches);
  }
  function updateThemeToggle() {
    const dark = isDarkTheme();
    const label = dark ? "Switch to light theme" : "Switch to dark theme";
    themeToggle.setAttribute("aria-label", label);
    themeToggle.title = label;
    document.getElementById("theme-icon-moon").toggleAttribute("hidden", dark);
    document.getElementById("theme-icon-sun").toggleAttribute("hidden", !dark);
  }
  updateThemeToggle();
  systemTheme.addEventListener("change", updateThemeToggle);
  themeToggle.addEventListener("click", () => {
    const root = document.documentElement;
    root.dataset.theme = isDarkTheme() ? "light" : "dark";
    try { localStorage.setItem("theme", root.dataset.theme); } catch { /* storage unavailable */ }
    updateThemeToggle();
  });
  document.getElementById("active-worker").addEventListener("change", (event) => {
    setActiveWorker(event.target.value);
    refreshCurrent();
  });
  document.getElementById("log-worker").addEventListener("change", (event) => {
    setActiveWorker(event.target.value);
    refreshCurrent();
  });
  document.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  document.getElementById("places-filters").addEventListener("submit", (event) => {
    event.preventDefault();
    applyPlaceFilters();
  });
  document.getElementById("place-reset").addEventListener("click", () => {
    ["place-query", "place-outcome", "place-status", "place-review"].forEach((id) => {
      document.getElementById(id).value = "";
    });
    applyPlaceFilters();
  });
  document.getElementById("logs-filters").addEventListener("submit", (event) => {
    event.preventDefault();
    applyLogFilters();
  });
  document.getElementById("log-reset").addEventListener("click", () => {
    ["log-severity", "log-from", "log-to"].forEach((id) => { document.getElementById(id).value = ""; });
    applyLogFilters();
  });
  ["log-from", "log-to"].forEach((id) => {
    document.getElementById(id).addEventListener("input", () => setLogDateError(""));
  });
  document.getElementById("place-dialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  document.getElementById("place-dialog").addEventListener("close", (event) => {
    if (!event.currentTarget.open) {
      detailRequest += 1;
      detailPlace = null;
      detailPlaceLoaded = false;
      document.getElementById("attempts-table").removeAttribute("aria-busy");
      const opener = detailOpenerKey && Array.from(document.querySelectorAll("#places-table [data-focus-key]"))
        .find((element) => element.dataset.focusKey === detailOpenerKey);
      detailOpenerKey = null;
      if (activeView === "places") (opener || document.getElementById("place-search")).focus({ preventScroll: true });
    }
  });
  document.getElementById("detail-close").addEventListener("click", () => document.getElementById("place-dialog").close());
  document.getElementById("detail-retry").addEventListener("click", () => refreshDetail());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopPolling();
      workersRequest += 1;
      viewRequest += 1;
      detailRequest += 1;
      statusRequest += 1;
      document.querySelectorAll(".view[aria-busy]").forEach((section) => section.removeAttribute("aria-busy"));
      document.getElementById("attempts-table").removeAttribute("aria-busy");
    }
    else if (client) {
      refreshAll();
      startPolling();
    }
  });

  if (!window.supabase?.createClient) {
    document.querySelector("#overview-view .view-placeholder").textContent = "Unable to load overview. Reload the page to retry.";
    setError("Supabase browser library did not load.");
    return;
  }
  if (!config.supabaseUrl || !config.supabasePublishableKey) {
    document.querySelector("#overview-view .view-placeholder").textContent = "Unable to load overview. Check the dashboard configuration and reload.";
    setError("Copy config.example.js to config.js and add the Supabase URL and publishable key.");
    return;
  }
  // Read-only public access: the anon role is limited to SELECT by migration 0002.
  client = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  startApp();
})();
