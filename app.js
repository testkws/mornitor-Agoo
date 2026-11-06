(() => {
  "use strict";

  const PAGE_SIZE = 50;
  const POLL_INTERVAL = 5 * 60_000;
  const HEARTBEAT_WINDOW = 10 * 60_000;
  const STATUS_LABELS = {
    found: "พบสถานที่", found_no_phone: "พบสถานที่ (ไม่มีเบอร์โทร)", not_found: "ไม่พบสถานที่",
    ambiguous: "ผลลัพธ์ไม่ชัดเจน", lookup_error: "ข้อผิดพลาดในการค้นหา",
    pending: "รอดำเนินการ", running: "กำลังทำงาน", retry_wait: "รอลองอีกครั้ง", checked: "ตรวจแล้ว",
    exhausted: "ครบจำนวนครั้งแล้ว", skipped: "ข้ามแล้ว", blocked: "ถูกบล็อก", failed: "ล้มเหลว",
    paused: "หยุดชั่วคราว", no_due_work: "ไม่มีงานที่ถึงกำหนด", interrupted: "ถูกขัดจังหวะ",
    debug: "ข้อมูลวินิจฉัย", info: "ข้อมูล", warning: "คำเตือน", error: "ข้อผิดพลาด",
    "needs review": "ต้องตรวจทาน",
  };
  const EVENT_LABELS = {
    imported_snapshot: "นำเข้าภาพสถานะ", run_started: "เริ่มการทำงาน", heartbeat: "สัญญาณชีพ",
    lookup_started: "เริ่มค้นหา", lookup_completed: "ค้นหาเสร็จแล้ว", lookup_retry: "ลองค้นหาอีกครั้ง", run_ended: "สิ้นสุดการทำงาน",
    queue_resumed: "กลับมาทำงานต่อ", queue_paused: "หยุดคิวชั่วคราว",
  };
  const config = window.GOOGLE_MONITORING_CONFIG || {};
  const globalError = document.getElementById("global-error");
  const eventDetails = new Map();
  const attemptEvidence = new Map();
  const detailLoads = new Map();
  const placeAttemptTimes = new Map();
  const placeAttemptLoads = new Map();
  let client = null;
  let workers = [];
  let activeWorker = "";
  let activeView = "overview";
  let placesOffset = 0;
  let placesTotal = 0;
  let placeFilters = { query: "", outcome: "", queueStatus: "", review: null };
  let placeTimeSignature = "";
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
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("th-TH-u-nu-latn");
  }

  function durationMilliseconds(startedAt, completedAt) {
    if (!startedAt || !completedAt) return null;
    const elapsed = Date.parse(completedAt) - Date.parse(startedAt);
    return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
  }

  function formatDuration(startedAt, completedAt) {
    const elapsed = durationMilliseconds(startedAt, completedAt);
    if (elapsed === null) return "—";
    if (elapsed === 0) return "0 วินาที";
    if (elapsed < 100) return "น้อยกว่า 0.1 วินาที";
    const tenths = Math.round(elapsed / 100);
    const minutes = Math.floor(tenths / 600);
    const seconds = (tenths % 600) / 10;
    return `${minutes ? `${minutes} นาที ` : ""}${seconds} วินาที`;
  }

  function formatCount(value) {
    return Number(value || 0).toLocaleString("th-TH-u-nu-latn");
  }

  function setError(message = "") {
    globalError.classList.remove("warning");
    globalError.textContent = message;
    const hasData = document.getElementById(`${activeView}-view`).querySelector(".summary-grid, .table-wrap");
    const staleNote = document.getElementById("stale-note");
    if (!message) lastSuccessfulUpdate = new Date();
    staleNote.textContent = `ข้อมูลบางส่วนอาจไม่เป็นปัจจุบัน${lastSuccessfulUpdate
      ? ` อัปเดตล่าสุด ${lastSuccessfulUpdate.toLocaleTimeString("th-TH-u-nu-latn")}` : ""} กดรีเฟรชตอนนี้เพื่อลองอีกครั้ง`;
    staleNote.hidden = !message || !hasData;
    setLive(message ? "bad" : "ok", message ? "อัปเดตไม่สำเร็จ" : `อัปเดตแล้ว ${lastSuccessfulUpdate.toLocaleTimeString("th-TH-u-nu-latn")}`);
  }

  function setWarning(message) {
    globalError.classList.add("warning");
    globalError.textContent = message;
    document.getElementById("stale-note").hidden = true;
    setLive("warning", "อัปเดตบางส่วน");
  }

  function setLive(state, text) {
    const live = document.getElementById("live-status");
    live.className = `live ${state}`;
    document.getElementById("live-text").textContent = text;
  }

  function errorText(error, fallback) {
    const detail = error?.message;
    return detail ? `${fallback} (${detail})` : fallback;
  }

  const PILL_TONES = {
    found: "ok", checked: "ok", info: "info", running: "info", pending: "neutral", debug: "neutral", skipped: "neutral",
    found_no_phone: "warn", ambiguous: "warn", retry_wait: "warn", warning: "warn",
    not_found: "bad", exhausted: "bad", blocked: "bad", failed: "bad", error: "bad",
  };

  function pill(value, label = value) {
    if (value == null || value === "" || value === "—") return "—";
    return { node: el("span", `pill ${PILL_TONES[value] || "neutral"}`, STATUS_LABELS[label] || label) };
  }

  function eventLabel(value) {
    return EVENT_LABELS[value] || value || "—";
  }

  function resultOrThrow(result) {
    if (result.error) throw result.error;
    return result.data;
  }

  function makeTable(headers, rows, label, emptyMessage = "ไม่พบรายการ") {
    const wrapper = el("div", "table-wrap");
    wrapper.tabIndex = 0;
    wrapper.setAttribute("role", "region");
    wrapper.setAttribute("aria-label", label);
    const scrollHint = el("p", "table-scroll-hint", "เลื่อนด้านข้างเพื่อดูคอลัมน์ทั้งหมด");
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
    const description = `หน้า ${page} จาก ${pages} · ${formatCount(total)} รายการ`;
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
    const title = picker.selectedOptions[0]?.textContent || "เวิร์กเกอร์ทั้งหมด";
    if (picker.title !== title) picker.title = title;
  }

  function populateWorkers() {
    const active = document.getElementById("active-worker");
    const logWorker = document.getElementById("log-worker");
    const options = [{ value: "", label: "เวิร์กเกอร์ทั้งหมด" }, ...workers.map((worker) => ({
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
    if (numerator === null || denominator === null) return { value: "—", detail: "ไม่มีข้อมูลจำนวนครั้ง" };
    if (!denominator) return { value: "—", detail: "ไม่มีการลองตรวจสอบที่เสร็จแล้ว" };
    return {
      value: `${(numerator * 100 / denominator).toFixed(1)}%`,
      detail: `${formatCount(numerator)} จาก ${formatCount(denominator)} ครั้ง`,
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
    const title = el("h3", "chart-title", "ผลการลองตรวจสอบ");
    title.id = "attempt-chart-title";
    section.setAttribute("aria-labelledby", title.id);
    section.append(title, el("p", "chart-description", "การลองตรวจสอบที่เสร็จแล้ว · 24 ชั่วโมงล่าสุด"));

    if (attempts.matched === null || attempts.total === null) {
      section.append(el("p", "chart-empty", "ไม่มีข้อมูลจำนวนครั้ง ระบบจะลองใหม่อัตโนมัติ"));
      return section;
    }
    if (!attempts.total) {
      section.append(el("p", "chart-empty", "ไม่มีการลองตรวจสอบที่เสร็จแล้วใน 24 ชั่วโมงที่ผ่านมา"));
      return section;
    }

    const matched = attempts.matched;
    const other = attempts.total - matched;
    const layout = el("div", "chart-donut-layout");
    const donut = el("div", "chart-donut");
    donut.style.setProperty("--matched-share", `${matched * 100 / attempts.total}%`);
    const center = el("div", "chart-donut-center");
    center.append(el("strong", "", formatCount(attempts.total)), el("span", "", "เสร็จแล้ว"));
    donut.append(center);

    const legend = el("ul", "chart-legend");
    [
      { key: "matched", label: "จับคู่ได้", count: matched },
      { key: "other", label: "ผลลัพธ์อื่น", count: other },
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
    section.append(layout, el("p", "chart-note", "ผลที่จับคู่ได้รวมทั้งรายการที่มีและไม่มีเบอร์โทร"));
    return section;
  }

  function queueChart(pending, scheduled, running) {
    const section = el("section", "chart-panel");
    section.dataset.chart = "queue";
    const title = el("h3", "chart-title", "ภาพรวมคิว");
    title.id = "queue-chart-title";
    section.setAttribute("aria-labelledby", title.id);
    section.append(title, el("p", "chart-description", "จำนวนล่าสุดที่อัปโหลด · ปรับสเกลตามกลุ่มที่มีจำนวนมากที่สุด"));

    const rows = [
      { key: "pending", label: "รอดำเนินการ", count: pending },
      { key: "scheduled", label: "กำหนดไว้", count: scheduled },
      { key: "running", label: "กำลังทำงาน", count: running },
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
    section.append(list, el("p", "chart-note", "รายการที่กำหนดไว้รวมการตรวจซ้ำในอนาคต"));
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
    if (!Array.isArray(data?.workers)) throw new Error("ไม่มีข้อมูลเวิร์กเกอร์");
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
    intro.append(el("p", "eyebrow", "มอนิเตอร์ / ภาพรวม"), el("h2", "overview-title", "สรุปการทำงาน"),
      el("p", "overview-description", "ดูประสิทธิภาพ สถานะคิว และการทำงานของเวิร์กเกอร์ได้ในที่เดียว"));
    const period = el("div", "period-label", "24 ชั่วโมงล่าสุด");
    heading.append(intro, period);
    content.append(heading);

    const summary = el("div", "summary-grid");
    summary.append(
      summaryCard("success", "อัตราความสำเร็จ", successRate.value, successRate.detail, "จับคู่ได้ ทั้งรายการที่มีและไม่มีเบอร์โทร", "✓", "success", successRate.percent),
      summaryCard("blocked", "CAPTCHA / การบล็อก", attempts.blocked === null ? "—" : formatCount(attempts.blocked),
        attempts.blocked === null ? "ไม่มีข้อมูลจำนวนครั้ง" : "ครั้งที่ค้นหาแล้วถูกบล็อก",
        attempts.consent === null ? "ไม่มีข้อมูลคำขอความยินยอม" : `ต้องขอความยินยอม ${formatCount(attempts.consent)} ครั้ง`, "!", "danger"),
      summaryCard("retry", "อัตราการลองซ้ำ", retryRate.value, retryRate.detail, "กำหนดให้ลองใหม่หลังเกิดข้อผิดพลาดชั่วคราว", "↻", "warning", retryRate.percent),
      summaryCard("queue", "รายการในคิว", formatCount(pending + scheduled),
        `${formatCount(pending)} รอดำเนินการ · ${formatCount(scheduled)} กำหนดไว้`,
        `${formatCount(running)} กำลังทำงาน · รวมการตรวจซ้ำในอนาคต`, "≡", "info"),
      summaryCard("workers", "สถานะเวิร์กเกอร์", chosenWorkers.length ? `${formatCount(reporting)} / ${formatCount(chosenWorkers.length)}` : "—",
        chosenWorkers.length ? "ได้รับสัญญาณชีพล่าสุด" : "ยังไม่มีเวิร์กเกอร์",
        chosenWorkers.length ? `${formatCount(chosenWorkers.length - reporting)} ไม่มีสัญญาณชีพล่าสุด · ${formatCount(paused)} รายงานว่าหยุดทำงานล่าสุด` : "กำลังรอข้อมูลเวิร์กเกอร์", "◉", "accent"),
    );
    content.append(summary);
    content.append(el("p", "summary-note", "ประสิทธิภาพคำนวณจากการลองตรวจสอบที่เสร็จแล้วใน 24 ชั่วโมงล่าสุด ส่วนสถานะคิวและเวิร์กเกอร์อ้างอิงภาพสถานะที่อัปโหลดล่าสุด"));

    const chartHeading = el("div", "activity-section-heading");
    chartHeading.append(el("p", "eyebrow", "ภาพรวม"), el("h2", "activity-section-title", "รายละเอียดกิจกรรม"));
    const charts = el("div", "charts-grid");
    charts.append(attemptChart(attempts), queueChart(pending, scheduled, running));
    content.append(chartHeading, charts);

    const workerHeading = el("div", "worker-section-heading");
    const workerIntro = el("div");
    workerIntro.append(el("p", "eyebrow", "กิจกรรมของเวิร์กเกอร์"), el("h2", "worker-section-title", "เวิร์กเกอร์"));
    workerHeading.append(workerIntro, el("p", "worker-section-note", "สัญญาณชีพที่ได้รับภายใน 10 นาทีล่าสุด"));
    content.append(workerHeading);

    if (!chosenWorkers.length) content.append(el("p", "empty panel", "ยังไม่มีการตั้งค่าเวิร์กเกอร์ Scraper"));
    chosenWorkers.forEach((worker) => {
      const state = worker.current_state || {};
      const recent = heartbeatRecent(worker, now);
      const runStatus = recent ? "สัญญาณชีพล่าสุด" : "เวิร์กเกอร์ไม่รายงานสถานะ";
      const runBadge = el("span", `badge${recent ? "" : " warning"}`, runStatus);
      const section = el("section", "worker-panel");
      const header = el("div", "worker-head");
      const identity = el("div", "worker-identity");
      const avatar = el("span", "worker-avatar", workerLabel(worker).slice(0, 1).toUpperCase());
      avatar.setAttribute("aria-hidden", "true");
      const identityText = el("div");
      identityText.append(el("h3", "worker-name", workerLabel(worker)), el("p", "worker-id", `รหัสเวิร์กเกอร์ ${worker.worker_id}`));
      identity.append(avatar, identityText);
      const badges = el("div", "worker-badges");
      badges.append(runBadge);
      if (state.pause_reason) badges.append(el("span", "badge error", `รายงานว่าหยุดทำงานล่าสุด: ${state.pause_reason}`));
      else if (state.state_event_type === "queue_resumed") badges.append(el("span", "badge", "กลับมาทำงานต่อแล้ว"));
      else if (state.state_event_type === "run_ended") badges.append(el("span", "badge", "Runner หยุดทำงานแล้ว"));
      header.append(identity, badges);
      section.append(header);

      const usage = state.daily_usage != null ? `${formatCount(state.daily_usage)} / ${state.daily_limit == null ? "—" : formatCount(state.daily_limit)}` : "—";
      const day = state.bangkok_day ? `วันที่ตามเวลาไทย ${state.bangkok_day}` : "ยังไม่มีรายงานการใช้งาน";
      const current = state.current_job ? `${state.current_job.name || "สถานที่ไม่มีชื่อ"} · ${state.current_job.osm_id || "—"}` : "ยังไม่มีรายงานการค้นหา";
      const exit = worker.last_exit ? `${STATUS_LABELS[worker.last_exit.outcome] || worker.last_exit.outcome || "รายงานการสิ้นสุด"}${worker.last_exit.reason ? ` · ${worker.last_exit.reason}` : ""}` : "ยังไม่มีรายงานการสิ้นสุดรอบทำงาน";
      const queue = state.queue_counts || {};
      const queueLine = Object.entries(queue).map(([name, count]) => `${STATUS_LABELS[name] || name}: ${formatCount(count)}`).join(" · ") || "ยังไม่มีรายงานจำนวนในคิว";
      const stats = el("div", "worker-stats");
      stats.append(
        workerStat("การใช้งานรายวัน / ขีดจำกัด", usage, day),
        workerStat("การค้นหาที่รายงานล่าสุด", current, `รออัปโหลด: ${state.pending_upload_count == null ? "—" : formatCount(state.pending_upload_count)}`),
        workerStat("สัญญาณชีพล่าสุด", formatDate(worker.last_heartbeat_at), recent ? "ได้รับภายใน 10 นาที" : "ไม่ได้รับสัญญาณชีพล่าสุด"),
        workerStat("อัปโหลดล่าสุด", formatDate(worker.last_upload_at), `พบล่าสุด ${formatDate(worker.last_seen_at)}`),
      );
      section.append(stats);
      const detail = el("div", "worker-meta");
      const lastExit = worker.last_exit || {};
      const safety = Number(lastExit.safety_sequence || 0) > Number(state.safety_sequence || state.state_sequence || 0)
        ? lastExit.safety : state.safety;
      const recentErrors = safety && safety.recent_temporary_errors != null && safety.recent_attempts != null
        ? `${formatCount(safety.recent_temporary_errors)} / ${formatCount(safety.recent_attempts)} ครั้งล่าสุด · เกิดต่อเนื่อง ${formatCount(safety.consecutive_temporary_errors)} ครั้ง`
        : "ยังไม่มีรายงาน";
      detail.append(el("span", "", `คิว: ${queueLine}`), el("span", "", `รายงานการสิ้นสุดล่าสุด: ${exit}`),
        el("span", "", `ข้อผิดพลาดชั่วคราว: ${recentErrors}`));
      section.append(detail);
      content.append(section);
    });
    container.replaceChildren(content);
    return unavailable ? "ข้อมูลประสิทธิภาพบางรายการไม่พร้อมใช้งาน ระบบจะลองใหม่อัตโนมัติ" : "";
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
      setLogDateError("กรุณาระบุวันที่เริ่มต้นและวันที่สิ้นสุดให้ถูกต้อง");
      return;
    }
    if (fromTime !== null && toTime !== null && fromTime > toTime) {
      setLogDateError("วันที่เริ่มต้นต้องไม่อยู่หลังวันที่สิ้นสุด");
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

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const attemptKey = (workerId, attemptId) => JSON.stringify([workerId, attemptId]);

  async function placeDurations(places) {
    const requested = new Map();
    places.forEach((place) => {
      if (UUID.test(place.worker_id || "") && UUID.test(place.latest_attempt_id || "")) {
        requested.set(attemptKey(place.worker_id, place.latest_attempt_id), {
          workerId: place.worker_id, attemptId: place.latest_attempt_id,
        });
      }
    });
    const needed = Array.from(requested, ([key, pair]) => ({ key, ...pair }))
      .filter(({ key }) => !placeAttemptTimes.has(key) && !placeAttemptLoads.has(key));

    if (needed.length) {
      const groups = new Map();
      needed.forEach(({ workerId, attemptId }) => {
        if (!groups.has(workerId)) groups.set(workerId, []);
        groups.get(workerId).push(attemptId);
      });
      // UUID validation above makes these raw PostgREST filters safe. Grouping
      // by worker preserves the composite attempt identity in a single request.
      const filter = Array.from(groups, ([workerId, ids]) =>
        `and(worker_id.eq.${workerId},attempt_id.in.(${ids.join(",")}))`).join(",");
      const request = (async () => {
        const result = await client.from("monitoring_attempts")
          .select("worker_id,attempt_id,osm_id,worker_started_at,worker_completed_at").or(filter);
        (resultOrThrow(result) || []).forEach((attempt) => {
          const key = attemptKey(attempt.worker_id, attempt.attempt_id);
          if (requested.has(key)) placeAttemptTimes.set(key, attempt);
        });
      })();
      needed.forEach(({ key }) => placeAttemptLoads.set(key, request));
      const clear = () => needed.forEach(({ key }) => {
        if (placeAttemptLoads.get(key) === request) placeAttemptLoads.delete(key);
      });
      request.then(clear, clear);
    }

    await Promise.all(new Set(Array.from(requested.keys(), (key) => placeAttemptLoads.get(key)).filter(Boolean)));
    return places.flatMap((place, index) => {
      const attempt = placeAttemptTimes.get(attemptKey(place.worker_id, place.latest_attempt_id));
      if (!attempt || attempt.osm_id !== place.osm_id) return [];
      const elapsed = durationMilliseconds(attempt.worker_started_at, attempt.worker_completed_at);
      return elapsed === null ? [] : [{ place, attempt, elapsed, index }];
    }).sort((a, b) => b.elapsed - a.elapsed || a.index - b.index);
  }

  async function renderPlaceTimes(places, signature, isCurrent) {
    const container = document.getElementById("place-time-chart");
    const previous = container.querySelector(".place-time-list");
    if (signature !== placeTimeSignature || !previous) {
      const loading = el("p", "chart-empty", "กำลังโหลดเวลาตรวจสอบ…");
      loading.setAttribute("role", "status");
      container.replaceChildren(loading);
    }
    placeTimeSignature = signature;
    container.setAttribute("aria-busy", "true");
    try {
      const durations = await placeDurations(places);
      if (!isCurrent()) return "";
      const focusedList = container.querySelector(".place-time-list");
      const hadFocus = focusedList && focusedList === document.activeElement;
      const scrollTop = focusedList?.scrollTop || 0;
      if (!durations.length) {
        container.replaceChildren(el("p", "chart-empty", places.length
          ? "ยังไม่มีเวลาตรวจสอบที่เสร็จแล้วสำหรับสถานที่เหล่านี้"
          : "ไม่มีสถานที่ให้เปรียบเทียบในหน้านี้"));
        if (hadFocus) document.getElementById("place-time-title").focus({ preventScroll: true });
        return "";
      }
      const maximum = Math.max(...durations.map(({ elapsed }) => elapsed));
      const list = el("ol", "place-time-list");
      list.tabIndex = 0;
      list.setAttribute("aria-label", "เวลาตรวจสอบ เรียงจากนานที่สุด");
      durations.forEach(({ place, attempt, elapsed }) => {
        const item = el("li", "place-time-item");
        item.dataset.osmId = place.osm_id;
        item.dataset.workerId = place.worker_id;
        const heading = el("div", "place-time-heading");
      const label = el("span", "place-time-label", place.source_record?.name || "(ไม่มีชื่อ)");
        label.append(el("span", "place-time-meta", `${place.osm_id} · ${place.worker_id.slice(0, 8)}`));
        heading.append(label, el("strong", "place-time-value",
          formatDuration(attempt.worker_started_at, attempt.worker_completed_at)));
        const track = el("div", "chart-bar-track");
        track.setAttribute("aria-hidden", "true");
        const fill = el("span", "chart-bar-fill");
        fill.style.width = `${maximum ? elapsed * 100 / maximum : 0}%`;
        track.append(fill);
        item.append(heading, track);
        list.append(item);
      });
      const missing = places.length - durations.length;
      const note = el("p", "place-time-note", `${formatCount(durations.length)} จาก ${formatCount(places.length)} สถานที่ ` +
        `มีการบันทึกเวลา เรียงจากนานที่สุด${missing ? ` · ไม่มีข้อมูล ${formatCount(missing)} แห่ง` : ""}`);
      container.replaceChildren(list, note);
      if (list.scrollHeight > list.clientHeight) note.textContent += " · เลื่อนเพื่อดูทั้งหมด";
      if (hadFocus) {
        list.focus({ preventScroll: true });
        list.scrollTop = scrollTop;
      }
      return "";
    } catch {
      if (!isCurrent()) return "";
      const hadFocus = container.contains(document.activeElement);
      const message = el("p", "chart-empty", "โหลดเวลาตรวจสอบไม่สำเร็จ");
      const retry = el("button", "secondary", "ลองโหลดกราฟอีกครั้ง");
      retry.type = "button";
      retry.addEventListener("click", () => {
        document.getElementById("place-time-title").focus({ preventScroll: true });
        refreshCurrent();
      });
      container.replaceChildren(message, retry);
      if (hadFocus) retry.focus({ preventScroll: true });
      return "กราฟเวลาตรวจสอบไม่พร้อมใช้งาน ระบบจะลองใหม่อัตโนมัติ";
    } finally {
      if (isCurrent()) container.removeAttribute("aria-busy");
    }
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
        .select("worker_id,osm_id,name:source_record->>name,outcome,queue_status,review_flag,latest_error_code,latest_attempt_id", { count: "exact" })
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
    const places = data.rows || [];
    const rows = places.map((place) => {
      const name = place.source_record?.name || "(ไม่มีชื่อ)";
      const button = el("button", "link", name);
      button.type = "button";
      button.dataset.focusKey = JSON.stringify([place.worker_id, place.osm_id]);
      button.addEventListener("click", () => openDetail(place));
      return [button, place.worker_id.slice(0, 8), place.osm_id, pill(place.outcome), pill(place.queue_status), place.review_flag ? pill("warning", "needs review") : "—", place.latest_error_code || "—"];
    });
    const filtered = query || outcome || queueStatus || review !== null || activeWorker;
    const emptyMessage = filtered
      ? "ไม่พบสถานที่ที่ตรงกับตัวกรองปัจจุบัน ลองปรับตัวกรองหรือเลือกเวิร์กเกอร์อื่น"
      : "ยังไม่มีรายงานสถานที่";
    replaceTable(document.getElementById("places-table"), makeTable(
      ["ชื่อ", "เวิร์กเกอร์", "OSM ID", "ผลลัพธ์", "คิว", "ตรวจทาน", "ข้อผิดพลาดล่าสุด"], rows, "ตารางสถานที่", emptyMessage,
    ));
    setPager("places", offset, placesTotal,
      () => { placesOffset = Math.max(0, offset - PAGE_SIZE); refreshCurrent(); },
      () => { placesOffset = offset + PAGE_SIZE; refreshCurrent(); });
    return renderPlaceTimes(places, JSON.stringify([activeWorker, placeFilters, offset]), isCurrent);
  }

  function openDetail(place) {
    detailRequest += 1;
    detailPlace = place;
    detailPlaceLoaded = false;
    detailOpenerKey = JSON.stringify([place.worker_id, place.osm_id]);
    attemptsOffset = 0;
    document.getElementById("detail-title").textContent = `${place.source_record?.name || "สถานที่"} · ${place.osm_id}`;
    document.getElementById("detail-error").textContent = "";
    const retry = document.getElementById("detail-retry");
    retry.hidden = true;
    retry.disabled = false;
    const loading = el("p", "muted detail-loading", "กำลังโหลดรายละเอียดสถานที่…");
    loading.setAttribute("role", "status");
    document.getElementById("detail-content").replaceChildren(loading);
    document.getElementById("attempts-table").replaceChildren();
    document.getElementById("attempts-page").textContent = "กำลังโหลด…";
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
        if (!place) throw new Error("ไม่พบรายละเอียดสถานที่นี้แล้ว");
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
        detailPanel("ข้อมูลต้นทาง OSM", place.source_record),
        detailPanel(pendingReview ? "รายการที่ใกล้ที่สุดที่แนะนำ — รอตรวจทาน" :
          reviewed ? "รายการ Google ที่ใกล้ที่สุดและตรวจทานแล้ว" : "ข้อเสนอ Google ที่สำเร็จล่าสุด", place.google_proposal),
      );
      const content = document.createDocumentFragment();
      if (pendingReview) content.append(el("p", "muted", "รายการแนะนำนี้จะไม่ถูกรวมในการส่งออกจนกว่าจะอนุมัติบนเซิร์ฟเวอร์ Scraper ใช้รายการตรวจทานเพื่อค้นหา ID"));
      content.append(columns, detailPanel("ตัวเลือกที่ตรงกันล่าสุด", place.candidates));
      content.append(el("p", "muted", `วิธีจับคู่: ${place.matching_method || "—"} · ความคล้ายคลึง: ${place.similarity ?? "—"} · ระยะทาง: ${place.distance_m ?? "—"} ม. · ธงตรวจทาน: ${place.review_flag ? "มี" : "ไม่มี"}`));
      if (place.latest_error_code || place.latest_error_message) {
        const error = el("div", "panel");
        error.append(el("strong", "", `ข้อผิดพลาดล่าสุด ${place.latest_error_code || ""}`));
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
        ["เสร็จเมื่อ", "ระยะเวลา", "สถานะ", "ผลลัพธ์", "การจับคู่", "ข้อผิดพลาดล่าสุด", "หลักฐาน"], rows,
        "ตารางประวัติการลองตรวจสอบ", "ยังไม่มีรายงานการลองตรวจสอบสำหรับสถานที่นี้",
      ));
      setPager("attempts", offset, attemptsTotal,
        () => { attemptsOffset = Math.max(0, offset - PAGE_SIZE); refreshDetail(); },
        () => { attemptsOffset = offset + PAGE_SIZE; refreshDetail(); });
      if (options.status === undefined && status === statusRequest) setError("");
      return true;
    } catch (error) {
      if (isCurrent()) {
        const message = errorText(error, "โหลดรายละเอียดสถานที่ไม่สำเร็จ");
        document.getElementById("detail-error").textContent = message;
        retry.hidden = false;
        const loading = document.querySelector("#detail-content .detail-loading");
        if (loading) {
          loading.textContent = "โหลดรายละเอียดสถานที่ไม่สำเร็จ กรุณาลองอีกครั้ง";
          document.getElementById("attempts-page").textContent = "ไม่พร้อมใช้งาน";
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
    const summary = el("summary", "", "ดูรายละเอียด");
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
      const loading = el("p", "muted", "กำลังโหลดรายละเอียด…");
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
        const message = el("p", "field-error", errorText(error, "โหลดรายละเอียดไม่สำเร็จ"));
        message.setAttribute("role", "alert");
        const retry = el("button", "secondary", "ลองโหลดรายละเอียดอีกครั้ง");
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
      label: `ดูหลักฐานของการลองตรวจสอบที่เสร็จเมื่อ ${formatDate(attempt.worker_completed_at)}`,
      load: async () => {
        const result = await client.from("monitoring_attempts").select("candidates,proposal,errors")
          .eq("worker_id", workerId).eq("attempt_id", attempt.attempt_id).maybeSingle();
        const evidence = resultOrThrow(result);
        if (!evidence) throw new Error("ไม่พบหลักฐานการลองตรวจสอบนี้แล้ว");
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
      formatDate(event.received_at), pill(event.severity), eventLabel(event.event_type),
      event.worker_id.slice(0, 8), event.run_id || "—",
      { node: jsonDisclosure(event), className: "wrap" },
    ]);
    const filtered = workerId || severity || fromTime || toTime;
    const emptyMessage = filtered
      ? "ไม่พบเหตุการณ์ที่ตรงกับตัวกรองปัจจุบัน ลองปรับตัวกรองหรือเลือกเวิร์กเกอร์อื่น"
      : "ยังไม่ได้รับเหตุการณ์การทำงาน";
    replaceTable(document.getElementById("logs-table"), makeTable(
      ["เวลาที่ได้รับ", "ระดับ", "เหตุการณ์", "เวิร์กเกอร์", "รอบทำงาน", "รายละเอียด"], rows, "ตารางบันทึกการทำงาน", emptyMessage,
    ));
    setPager("logs", offset, logsTotal,
      () => { logsOffset = Math.max(0, offset - PAGE_SIZE); refreshCurrent(); },
      () => { logsOffset = offset + PAGE_SIZE; refreshCurrent(); });
  }

  function jsonDisclosure(event) {
    const key = event.event_id;
    return lazyDisclosure({
      key, loadKey: `event:${key}`, cache: eventDetails,
      label: `ดูรายละเอียด ${eventLabel(event.event_type)} ที่ได้รับเมื่อ ${formatDate(event.received_at)}`,
      load: async () => {
        const result = await client.from("monitoring_operational_events").select("data")
          .eq("event_id", key).maybeSingle();
        const row = resultOrThrow(result);
        if (!row) throw new Error("ไม่พบรายละเอียดบันทึกเหตุการณ์นี้แล้ว");
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
    if (placeholder) placeholder.textContent = `กำลังโหลด${view === "overview" ? "ภาพรวม" : view === "places" ? "สถานที่" : "บันทึกเหตุการณ์"}…`;
    setLive("", "กำลังอัปเดต…");
    const status = ++statusRequest;
    const isCurrent = () => request === viewRequest && !document.hidden && activeView === view;
    try {
      let warning = "";
      if (view === "overview") warning = await renderOverview(isCurrent);
      else if (view === "places") {
        warning = await renderPlaces(isCurrent);
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
        if (placeholder) placeholder.textContent = `โหลด${view === "overview" ? "ภาพรวม" : view === "places" ? "สถานที่" : "บันทึกเหตุการณ์"}ไม่สำเร็จ กดรีเฟรชตอนนี้เพื่อลองอีกครั้ง`;
        setError(errorText(error, "โหลดข้อมูลมอนิเตอร์ไม่สำเร็จ"));
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
    setLive("", "กำลังอัปเดต…");
    try {
      if (view === "overview" || await refreshWorkers(isCurrent)) await refreshCurrent();
    } catch (error) {
      if (isCurrent() && status === statusRequest) {
        const placeholder = document.querySelector(`#${activeView}-view .view-placeholder`);
        if (placeholder) placeholder.textContent = `โหลด${activeView === "overview" ? "ภาพรวม" : activeView === "places" ? "สถานที่" : "บันทึกเหตุการณ์"}ไม่สำเร็จ กดรีเฟรชตอนนี้เพื่อลองอีกครั้ง`;
        setError(errorText(error, "รีเฟรชข้อมูลไม่สำเร็จ"));
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
    announcement.textContent = "กำลังรีเฟรชแดชบอร์ด…";
    await refreshAll();
    if (request !== manualRefresh || document.hidden) return;
    const live = document.getElementById("live-status");
    announcement.textContent = live.classList.contains("ok") ? "อัปเดตแดชบอร์ดแล้ว"
      : live.classList.contains("warning") ? "อัปเดตแดชบอร์ดแล้ว แต่ข้อมูลบางรายการไม่พร้อมใช้งาน" : "";
  });
  const themeToggle = document.getElementById("theme-toggle");
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  function isDarkTheme() {
    const selected = document.documentElement.dataset.theme;
    return selected === "dark" || (selected !== "light" && systemTheme.matches);
  }
  function updateThemeToggle() {
    const dark = isDarkTheme();
    const label = dark ? "เปลี่ยนเป็นธีมสว่าง" : "เปลี่ยนเป็นธีมมืด";
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
    document.querySelector("#overview-view .view-placeholder").textContent = "โหลดภาพรวมไม่สำเร็จ โหลดหน้าเว็บอีกครั้งเพื่อลองใหม่";
    setError("โหลดไลบรารี Supabase สำหรับเบราว์เซอร์ไม่สำเร็จ");
    return;
  }
  if (!config.supabaseUrl || !config.supabasePublishableKey) {
    document.querySelector("#overview-view .view-placeholder").textContent = "โหลดภาพรวมไม่สำเร็จ ตรวจสอบการตั้งค่าแดชบอร์ดแล้วโหลดหน้าเว็บอีกครั้ง";
    setError("คัดลอก config.example.js เป็น config.js แล้วเพิ่ม Supabase URL และ publishable key");
    return;
  }
  // Read-only public access: the anon role is limited to SELECT by migration 0002.
  client = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  startApp();
})();
