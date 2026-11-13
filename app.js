(() => {
  "use strict";

  const PAGE_SIZE = 50;
  const POLL_INTERVAL = 5 * 60_000;
  const HEARTBEAT_WINDOW = 10 * 60_000;
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  // Match the monitoring table so the CSV can be loaded into a staging table.
  const PLACE_EXPORT_FIELDS = [
    "worker_id", "osm_id", "source_record", "queue_status", "outcome", "google_proposal", "candidates",
    "matching_method", "similarity", "distance_m", "review_flag", "latest_error_code", "latest_error_message",
    "latest_attempt_id", "checked_at", "worker_updated_at", "received_at", "last_sequence",
  ];
  const { t } = I18N;
  I18N.translateStatic();
  const STATUS_LABELS = I18N.map({
    found: "พบสถานที่", found_no_phone: "พบสถานที่ (ไม่มีเบอร์โทร)", not_found: "ไม่พบสถานที่",
    ambiguous: "ผลลัพธ์ไม่ชัดเจน", lookup_error: "ข้อผิดพลาดในการค้นหา",
    pending: "รอดำเนินการ", running: "กำลังทำงาน", retry_wait: "รอลองอีกครั้ง", checked: "ตรวจแล้ว",
    exhausted: "ครบจำนวนครั้งแล้ว", skipped: "ข้ามแล้ว", blocked: "ถูกบล็อก", failed: "ล้มเหลว",
    paused: "หยุดชั่วคราว", no_due_work: "ไม่มีงานที่ถึงกำหนด", interrupted: "ถูกขัดจังหวะ",
    debug: "ข้อมูลวินิจฉัย", info: "ข้อมูล", warning: "คำเตือน", error: "ข้อผิดพลาด",
    "needs review": "ต้องตรวจทาน",
  });
  const EVENT_LABELS = I18N.map({
    imported_snapshot: "นำเข้าภาพสถานะ", run_started: "เริ่มการทำงาน", heartbeat: "สัญญาณชีพ",
    lookup_started: "เริ่มค้นหา", lookup_completed: "ค้นหาเสร็จแล้ว", lookup_retry: "ลองค้นหาอีกครั้ง", run_ended: "สิ้นสุดการทำงาน",
    queue_resumed: "กลับมาทำงานต่อ", queue_paused: "หยุดคิวชั่วคราว",
  });
  // Upper bounds match the buckets returned by the monitoring_activity RPC.
  const DURATION_LABELS = [t("ต่ำกว่า 10 วินาที"), t("10–20 วินาที"), t("20–30 วินาที"), t("30–60 วินาที"), t("1 นาทีขึ้นไป")];
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
  // Overview date range: preset length in days and how many whole periods back.
  let rangeDays = 7;
  let rangeOffset = 0;
  let trendMetric = "attempts";
  let trendCompare = false;
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
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString(I18N.locale);
  }

  function durationMilliseconds(startedAt, completedAt) {
    if (!startedAt || !completedAt) return null;
    const elapsed = Date.parse(completedAt) - Date.parse(startedAt);
    return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
  }

  function formatDuration(startedAt, completedAt) {
    const elapsed = durationMilliseconds(startedAt, completedAt);
    return elapsed === null ? "—" : formatElapsed(elapsed);
  }

  function formatElapsed(elapsed) {
    if (elapsed === 0) return t("0 วินาที");
    if (elapsed < 100) return t("น้อยกว่า 0.1 วินาที");
    const tenths = Math.round(elapsed / 100);
    const minutes = Math.floor(tenths / 600);
    const seconds = (tenths % 600) / 10;
    return `${minutes ? `${t("{n} นาที", { n: minutes })} ` : ""}${t("{n} วินาที", { n: seconds })}`;
  }

  function formatCount(value) {
    return Number(value || 0).toLocaleString(I18N.locale);
  }

  function setError(message = "") {
    globalError.classList.remove("warning");
    globalError.textContent = message;
    const hasData = document.getElementById(`${activeView}-view`).querySelector(".dash, .table-wrap");
    const staleNote = document.getElementById("stale-note");
    if (!message) lastSuccessfulUpdate = new Date();
    staleNote.textContent = `${t("ข้อมูลบางส่วนอาจไม่เป็นปัจจุบัน")}${lastSuccessfulUpdate
      ? ` ${t("อัปเดตล่าสุด {time}", { time: lastSuccessfulUpdate.toLocaleTimeString(I18N.locale) })}` : ""} ${t("กดรีเฟรชตอนนี้เพื่อลองอีกครั้ง")}`;
    staleNote.hidden = !message || !hasData;
    setLive(message ? "bad" : "ok", message ? t("อัปเดตไม่สำเร็จ") : t("อัปเดตแล้ว {time}", { time: lastSuccessfulUpdate.toLocaleTimeString(I18N.locale) }));
  }

  function setWarning(message) {
    globalError.classList.add("warning");
    globalError.textContent = message;
    document.getElementById("stale-note").hidden = true;
    setLive("warning", t("อัปเดตบางส่วน"));
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

  function viewName(view) {
    const name = t(view === "overview" ? t("ภาพรวม") : view === "places" ? t("สถานที่") : t("บันทึกเหตุการณ์"));
    return I18N.lang === "en" ? name.toLowerCase() : name;
  }

  function eventLabel(value) {
    return EVENT_LABELS[value] || value || "—";
  }

  function resultOrThrow(result) {
    if (result.error) throw result.error;
    return result.data;
  }

  function makeTable(headers, rows, label, emptyMessage = t("ไม่พบรายการ")) {
    const wrapper = el("div", "table-wrap");
    wrapper.tabIndex = 0;
    wrapper.setAttribute("role", "region");
    wrapper.setAttribute("aria-label", label);
    const scrollHint = el("p", "table-scroll-hint", t("เลื่อนด้านข้างเพื่อดูคอลัมน์ทั้งหมด"));
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
    const description = t("หน้า {page} จาก {pages} · {n} รายการ", { page, pages, n: formatCount(total) });
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
    const title = picker.selectedOptions[0]?.textContent || t("เวิร์กเกอร์ทั้งหมด");
    if (picker.title !== title) picker.title = title;
  }

  function populateWorkers() {
    const active = document.getElementById("active-worker");
    const logWorker = document.getElementById("log-worker");
    const options = [{ value: "", label: t("เวิร์กเกอร์ทั้งหมด") }, ...workers.map((worker) => ({
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

  // ---- Overview: date range ----

  // 24 hours is a rolling window of hourly points. 7 and 30 days cover today
  // plus the earlier local calendar days, as daily points. Earlier periods
  // (rangeOffset > 0) are always whole.
  function rangeWindow(now = Date.now()) {
    if (rangeDays === 1) {
      const top = new Date(now);
      top.setMinutes(0, 0, 0);
      const start = top.getTime() - 23 * HOUR - rangeOffset * DAY;
      return { start, end: rangeOffset ? start + DAY : now, buckets: 24, unit: "hour" };
    }
    const midnight = (days) => {
      const date = new Date(now);
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() + days);
      return date.getTime();
    };
    return {
      start: midnight(1 - rangeDays * (rangeOffset + 1)),
      end: rangeOffset ? midnight(1 - rangeDays * rangeOffset) : now,
      buckets: rangeDays,
      unit: "day",
    };
  }

  function rangeText(range) {
    const format = new Intl.DateTimeFormat(I18N.locale, range.unit === "hour"
      ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
      : { year: "numeric", month: "short", day: "numeric" });
    // A whole earlier period ends at midnight; name the last day it covers.
    const last = range.unit === "day" && rangeOffset ? range.end - 1 : range.end;
    return `${format.format(range.start)} → ${format.format(last)}`;
  }

  function syncRangeControls(range = rangeWindow()) {
    const label = document.getElementById("range-label");
    const text = rangeText(range);
    if (label.textContent !== text) label.textContent = text;
    document.getElementById("range-preset").value = String(rangeDays);
    document.getElementById("range-next").disabled = rangeOffset === 0;
    const hidden = activeView !== "overview";
    document.getElementById("range-stepper").hidden = hidden;
    document.getElementById("range-preset-field").hidden = hidden;
  }

  function setRange(days, offset) {
    rangeDays = days;
    rangeOffset = Math.max(0, offset);
    syncRangeControls();
    refreshCurrent();
  }

  // ---- Overview: activity aggregates ----

  const emptyBucket = () => ({ n: 0, ok: 0, err: 0, blk: 0, retry: 0, timed: 0, ms: 0 });
  const wholeCount = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);

  function addBucket(target, row) {
    Object.keys(target).forEach((key) => { target[key] += wholeCount(row[key]); });
  }

  function bucketOf(range, time) {
    if (range.unit === "hour") return Math.floor((time - range.start) / HOUR);
    const day = new Date(time);
    day.setHours(0, 0, 0, 0);
    return Math.round((day.getTime() - range.start) / DAY);
  }

  // The RPC numbers hours from the start of the range; negative hours belong to
  // the equal-length period before it. Days and weekdays use local time.
  function summarizeActivity(data, range) {
    const current = emptyBucket();
    const previous = emptyBucket();
    const series = Array.from({ length: range.buckets }, emptyBucket);
    const before = Array.from({ length: range.buckets }, emptyBucket);
    const heat = Array.from({ length: 24 }, () => Array(7).fill(0));
    data.hours.forEach((row) => {
      const index = Number(row?.i);
      if (!Number.isInteger(index)) return;
      const time = range.start + index * HOUR;
      const bucket = bucketOf(range, time);
      if (index >= 0) {
        addBucket(current, row);
        if (series[bucket]) addBucket(series[bucket], row);
        const local = new Date(time);
        heat[local.getHours()][(local.getDay() + 6) % 7] += wholeCount(row.n);
      } else {
        addBucket(previous, row);
        if (before[bucket + range.buckets]) addBucket(before[bucket + range.buckets], row);
      }
    });
    const errors = Object.entries(data.errors && typeof data.errors === "object" ? data.errors : {})
      .map(([code, count]) => ({ code, count: wholeCount(count) }))
      .filter((entry) => entry.count)
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
    return {
      range, current, previous, series, before, heat, errors,
      durations: DURATION_LABELS.map((_, index) => wholeCount(data.durations?.[index])),
      consent: wholeCount(data.consent),
    };
  }

  async function fetchActivity(workerId, range) {
    try {
      const result = await client.rpc("monitoring_activity", {
        p_from: new Date(range.start).toISOString(),
        p_to: new Date(range.end).toISOString(),
        p_worker_id: workerId || null,
      });
      return !result.error && Array.isArray(result.data?.hours) ? summarizeActivity(result.data, range) : null;
    } catch {
      return null;
    }
  }

  function rate(numerator, denominator) {
    if (!denominator) return { value: "—", detail: t("ไม่มีการลองตรวจสอบที่เสร็จแล้ว"), percent: null };
    if (numerator > denominator) return { value: "—", detail: t("ไม่มีข้อมูลจำนวนครั้ง"), percent: null };
    return {
      value: `${(numerator * 100 / denominator).toFixed(1)}%`,
      detail: t("{a} จาก {b} ครั้ง", { a: formatCount(numerator), b: formatCount(denominator) }),
      percent: numerator * 100 / denominator,
    };
  }

  const averageDuration = (bucket) => (bucket.timed ? bucket.ms / bucket.timed : null);
  const secondsText = (milliseconds) => t("{n} วินาที", { n: (milliseconds / 1000).toFixed(1) });

  // ---- Overview: cards ----

  function card(key, titleText, subtitle) {
    const section = el("section", "card");
    section.dataset.chart = key;
    const title = el("h3", "card-title", titleText);
    title.id = `${key}-card-title`;
    section.setAttribute("aria-labelledby", title.id);
    const head = el("div", "card-head");
    head.append(title);
    section.append(head);
    if (subtitle) section.append(el("p", "card-sub", subtitle));
    return { section, head };
  }

  // The arrow and sign carry the direction; colour only says whether it is good.
  function deltaNode(difference, text, upIsGood) {
    if (difference === null || !Number.isFinite(difference)) return null;
    // A change too small to show is no change: never "−0.0 s" in green.
    const shown = text(Math.abs(difference));
    const direction = shown === text(0) ? "flat" : difference > 0 ? "up" : "down";
    const tone = direction === "flat" ? "flat" : (direction === "up") === upIsGood ? "good" : "bad";
    const node = el("p", `metric-delta ${tone}`);
    node.title = t("เทียบกับช่วงก่อนหน้า");
    const arrow = el("span", "metric-delta-arrow", direction === "up" ? "↑" : direction === "down" ? "↓" : "→");
    arrow.setAttribute("aria-hidden", "true");
    const sign = direction === "up" ? "+" : direction === "down" ? "−" : "";
    node.append(arrow, el("span", "", `${sign}${shown}`),
      el("span", "sr-only", ` ${t("เทียบกับช่วงก่อนหน้า")}`));
    return node;
  }

  function metricRow(key, label, value, note, delta) {
    const row = el("div", "metric-row");
    row.dataset.metric = key;
    const text = el("div", "metric-text");
    text.append(el("p", "metric-label", label), el("p", "summary-value", value));
    if (note) text.append(el("p", "metric-note", note));
    row.append(text);
    if (delta) row.append(delta);
    return row;
  }

  function comparisonNote(range) {
    return range.unit === "hour" ? t("เทียบกับ 24 ชั่วโมงก่อนหน้า")
      : t("เทียบกับ {n} วันก่อนหน้า", { n: range.buckets });
  }

  function keyMetricsCard(activity, range) {
    const { section, head } = card("metrics", t("ตัวชี้วัดหลัก"));
    head.append(el("span", "card-tag", comparisonNote(range)));
    const rows = el("div", "metric-rows");
    if (!activity) {
      const missing = t("ไม่มีข้อมูลจำนวนครั้ง");
      rows.append(metricRow("attempts", t("การลองตรวจสอบที่เสร็จแล้ว"), "—", missing),
        metricRow("success", t("อัตราความสำเร็จ"), "—", missing),
        metricRow("duration", t("เวลาตรวจสอบเฉลี่ย"), "—", missing));
      section.append(rows);
      return section;
    }
    const { current, previous } = activity;
    const success = rate(current.ok, current.n);
    const earlier = rate(previous.ok, previous.n);
    const average = averageDuration(current);
    const earlierAverage = averageDuration(previous);
    rows.append(
      metricRow("attempts", t("การลองตรวจสอบที่เสร็จแล้ว"), formatCount(current.n),
        t("จับคู่ได้ {n} ครั้ง", { n: formatCount(current.ok) }),
        deltaNode(current.n - previous.n, formatCount, true)),
      metricRow("success", t("อัตราความสำเร็จ"), success.value, success.detail,
        deltaNode(success.percent === null || earlier.percent === null ? null : success.percent - earlier.percent,
          (value) => t("{n} จุด", { n: value.toFixed(1) }), true)),
      metricRow("duration", t("เวลาตรวจสอบเฉลี่ย"), average === null ? "—" : formatElapsed(average),
        current.timed ? t("จาก {n} ครั้งที่มีการบันทึกเวลา", { n: formatCount(current.timed) }) : t("ยังไม่มีการบันทึกเวลา"),
        deltaNode(average === null || earlierAverage === null ? null : average - earlierAverage, secondsText, false)),
    );
    section.append(rows);
    return section;
  }

  // ---- Overview: activity over time ----

  const TREND_METRICS = {
    attempts: { label: t("การลองตรวจสอบที่เสร็จแล้ว"), value: (bucket) => bucket.n, text: formatCount, whole: true },
    matched: { label: t("จับคู่ได้"), value: (bucket) => bucket.ok, text: formatCount, whole: true },
    success: {
      label: t("อัตราความสำเร็จ"), value: (bucket) => (bucket.n ? Math.min(100, bucket.ok * 100 / bucket.n) : null),
      text: (value) => `${value.toFixed(1)}%`, tick: (value) => `${value}%`, fixed: [0, 25, 50, 75, 100],
    },
    errors: { label: t("ข้อผิดพลาดในการค้นหา", null, "Lookup errors"), value: (bucket) => bucket.err, text: formatCount, whole: true },
    duration: {
      label: t("เวลาตรวจสอบเฉลี่ย"), value: (bucket) => (bucket.timed ? bucket.ms / bucket.timed / 1000 : null),
      text: (value) => formatElapsed(value * 1000), tick: (value) => t("{n} วินาที", { n: value }),
    },
  };

  function axisTicks(peak, whole) {
    if (!(peak > 0)) return [0, 1];
    const rough = peak / 4;
    const power = 10 ** Math.floor(Math.log10(rough));
    const step = Math.max(whole ? 1 : 0, (whole ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10])
      .map((multiple) => multiple * power).find((candidate) => candidate >= rough));
    const count = Math.ceil(peak / step - 1e-9);
    return Array.from({ length: count + 1 }, (_, index) => Number((index * step).toFixed(6)));
  }

  function bucketLabels(range) {
    const hourly = range.unit === "hour";
    const short = new Intl.DateTimeFormat(I18N.locale, hourly ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric" });
    const long = new Intl.DateTimeFormat(I18N.locale, hourly
      ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
      : { weekday: "short", year: "numeric", month: "short", day: "numeric" });
    return Array.from({ length: range.buckets }, (_, index) => {
      const date = new Date(range.start + (hourly ? index * HOUR : 0));
      if (!hourly) date.setDate(date.getDate() + index);
      return { short: short.format(date), long: long.format(date) };
    });
  }

  function svgNode(name, attributes) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
    return node;
  }

  function drawTrend(body, activity) {
    const metric = TREND_METRICS[trendMetric];
    const labels = bucketLabels(activity.range);
    const values = activity.series.map(metric.value);
    const earlier = trendCompare ? activity.before.map(metric.value) : null;
    const known = values.concat(earlier || []).filter((value) => value !== null);
    const ticks = metric.fixed || axisTicks(Math.max(0, ...known), metric.whole);
    const top = ticks[ticks.length - 1];
    const compact = top >= 10_000 ? new Intl.NumberFormat(I18N.locale, { notation: "compact" }) : null;
    const tickText = (value) => (metric.tick ? metric.tick(value) : compact ? compact.format(value) : formatCount(value));
    const valueText = (value) => (value === null ? "—" : metric.text(value));
    const x = (index) => (values.length > 1 ? index * 100 / (values.length - 1) : 50);
    const y = (value) => 100 - value * 100 / top;
    const path = (series) => series.reduce((d, value, index) => (value === null ? d
      : `${d}${index === 0 || series[index - 1] === null ? "M" : "L"}${x(index).toFixed(2)} ${y(value).toFixed(2)}`), "");

    const chart = el("div", "trend-chart");
    const yAxis = el("div", "trend-yaxis");
    yAxis.setAttribute("aria-hidden", "true");
    ticks.forEach((tick) => yAxis.append(el("span", "", tickText(tick))));

    const plot = el("div", "trend-plot");
    plot.id = "trend-plot";
    plot.tabIndex = 0;
    plot.setAttribute("role", "group");
    plot.setAttribute("aria-label", t("{metric} · {range} ใช้ปุ่มลูกศรซ้ายขวาเพื่ออ่านค่าแต่ละช่วง",
      { metric: metric.label, range: rangeText(activity.range) }));
    const svg = svgNode("svg", { viewBox: "0 0 100 100", preserveAspectRatio: "none", "aria-hidden": "true" });
    ticks.forEach((tick) => svg.append(svgNode("line", { class: tick ? "trend-grid" : "trend-grid base", x1: 0, x2: 100, y1: y(tick), y2: y(tick) })));
    if (earlier) svg.append(svgNode("path", { class: "trend-line earlier", d: path(earlier) }));
    svg.append(svgNode("path", { class: "trend-line", d: path(values) }));
    plot.append(svg);

    const dot = (index, value, className) => {
      const mark = el("span", className);
      mark.style.left = `${x(index)}%`;
      mark.style.top = `${y(value)}%`;
      return mark;
    };
    const last = values.reduce((found, value, index) => (value === null ? found : index), -1);
    values.forEach((value, index) => {
      const alone = value !== null && (values[index - 1] ?? null) === null && (values[index + 1] ?? null) === null;
      if (alone || index === last) plot.append(dot(index, value, "trend-dot"));
    });

    const cursor = el("div", "trend-cursor");
    const marker = el("span", "trend-dot active");
    const tip = el("div", "trend-tip");
    tip.setAttribute("aria-live", "polite");
    [cursor, marker, tip].forEach((node) => { node.hidden = true; });
    plot.append(cursor, marker, tip);

    let active = -1;
    const show = (index) => {
      active = Math.min(values.length - 1, Math.max(0, index));
      cursor.hidden = false;
      cursor.style.left = `${x(active)}%`;
      marker.hidden = values[active] === null;
      if (values[active] !== null) {
        marker.style.left = `${x(active)}%`;
        marker.style.top = `${y(values[active])}%`;
      }
      const row = (className, value, label) => {
        const line = el("p", "trend-tip-row");
        const key = el("i", className);
        key.setAttribute("aria-hidden", "true");
        line.append(key, el("strong", "", valueText(value)), el("span", "", label));
        return line;
      };
      tip.replaceChildren(el("p", "trend-tip-title", labels[active].long), row("trend-key", values[active], metric.label));
      if (earlier) tip.append(row("trend-key earlier", earlier[active], t("ช่วงก่อนหน้า")));
      tip.hidden = false;
      tip.style.left = `${x(active)}%`;
      tip.classList.toggle("flip", x(active) > 55);
    };
    const hide = () => {
      active = -1;
      [cursor, marker, tip].forEach((node) => { node.hidden = true; });
    };
    const point = (event) => {
      const box = plot.getBoundingClientRect();
      if (box.width) show(Math.round((event.clientX - box.left) / box.width * (values.length - 1)));
    };
    // The crosshair follows the pointer; a tap shows the nearest point.
    ["pointermove", "pointerdown"].forEach((name) => plot.addEventListener(name, point));
    // Some browsers report only one of these when the pointer leaves.
    ["pointerleave", "mouseleave", "pointercancel"].forEach((name) => plot.addEventListener(name, () => {
      if (document.activeElement !== plot) hide();
    }));
    plot.addEventListener("focus", () => { if (active < 0) show(Math.max(0, last)); });
    plot.addEventListener("blur", hide);
    plot.addEventListener("keydown", (event) => {
      const next = { ArrowLeft: active - 1, ArrowRight: active + 1, Home: 0, End: values.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      show(next);
    });

    const xAxis = el("div", "trend-xaxis");
    xAxis.setAttribute("aria-hidden", "true");
    const every = Math.ceil(values.length / 7);
    labels.forEach((label, index) => {
      if ((values.length - 1 - index) % every) return;
      const text = el("span", index === 0 ? "first" : index === values.length - 1 ? "last" : "", label.short);
      text.style.left = `${x(index)}%`;
      xAxis.append(text);
    });
    chart.append(yAxis, plot, xAxis);

    const content = [chart];
    if (earlier) {
      const legend = el("ul", "trend-legend");
      [["trend-key", t("ช่วงนี้")], ["trend-key earlier", t("ช่วงก่อนหน้า")]].forEach(([className, label]) => {
        const item = el("li");
        const key = el("i", className);
        key.setAttribute("aria-hidden", "true");
        item.append(key, el("span", "", label));
        legend.append(item);
      });
      content.push(legend);
    }
    const details = el("details", "chart-table");
    details.id = "trend-table";
    details.open = body.querySelector("#trend-table")?.open === true;
    details.append(el("summary", "", t("ดูเป็นตาราง")), makeTable(
      [t("ช่วงเวลา"), metric.label].concat(earlier ? [t("ช่วงก่อนหน้า")] : []),
      labels.map((label, index) => [label.long, valueText(values[index])].concat(earlier ? [valueText(earlier[index])] : [])),
      t("ตาราง{name}", { name: metric.label }),
    ));
    content.push(details);
    body.replaceChildren(...content);
  }

  function trendCard(activity) {
    const { section, head } = card("trend", t("กิจกรรมตามช่วงเวลา"));
    const tools = el("div", "card-tools");
    const field = el("label", "chip-field");
    field.append(el("span", "sr-only", t("ตัวชี้วัดในกราฟ")));
    const picker = el("select");
    picker.id = "trend-metric";
    Object.entries(TREND_METRICS).forEach(([key, metric]) => {
      const option = el("option", "", metric.label);
      option.value = key;
      picker.append(option);
    });
    picker.value = trendMetric;
    field.append(picker);
    const compare = el("label", "chip-check");
    const box = el("input");
    box.type = "checkbox";
    box.id = "trend-compare";
    box.checked = trendCompare;
    compare.append(box, el("span", "", t("แสดงช่วงก่อนหน้า")));
    tools.append(field, compare);
    head.append(tools);
    const body = el("div", "trend-body");
    section.append(body);
    if (!activity) {
      picker.disabled = true;
      box.disabled = true;
      body.append(el("p", "chart-empty", t("ไม่มีข้อมูลกิจกรรม ระบบจะลองใหม่อัตโนมัติ")));
      return section;
    }
    drawTrend(body, activity);
    picker.addEventListener("change", () => { trendMetric = picker.value; drawTrend(body, activity); });
    box.addEventListener("change", () => { trendCompare = box.checked; drawTrend(body, activity); });
    return section;
  }

  // ---- Overview: busiest times and inspection time ----

  function heatmapCard(activity) {
    const { section } = card("heatmap", t("ช่วงเวลาที่ทำงานมากที่สุด"),
      t("การลองตรวจสอบที่เสร็จแล้ว แยกตามวันและชั่วโมง · เวลาท้องถิ่นของเบราว์เซอร์"));
    if (!activity || !activity.current.n) {
      section.append(el("p", "chart-empty", activity ? t("ไม่มีการลองตรวจสอบที่เสร็จแล้วในช่วงนี้")
        : t("ไม่มีข้อมูลกิจกรรม ระบบจะลองใหม่อัตโนมัติ")));
      return section;
    }
    const monday = new Date(2024, 0, 1);
    const weekday = (index, width) => new Intl.DateTimeFormat(I18N.locale, { weekday: width })
      .format(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index));
    const peak = Math.max(...activity.heat.flat());
    const table = el("table", "heat");
    table.append(el("caption", "sr-only", t("จำนวนการลองตรวจสอบที่เสร็จแล้ว แยกตามวันในสัปดาห์และชั่วโมง")));
    const headRow = el("tr");
    headRow.append(el("td"));
    for (let day = 0; day < 7; day += 1) {
      const cell = el("th", "", weekday(day, "short"));
      cell.scope = "col";
      headRow.append(cell);
    }
    const thead = el("thead");
    thead.append(headRow);
    const tbody = el("tbody");
    activity.heat.forEach((counts, hour) => {
      const row = el("tr");
      const label = el("th", "", `${String(hour).padStart(2, "0")}:00`);
      label.scope = "row";
      row.append(label);
      counts.forEach((count, day) => {
        // Five steps of one hue; zero keeps the empty wash.
        const cell = el("td", `heat-${count ? Math.max(1, Math.ceil(count * 5 / peak)) : 0}`, formatCount(count));
        cell.dataset.day = String(day);
        cell.dataset.hour = String(hour);
        cell.title = t("{day} {hour}:00 · {n} ครั้ง", { day: weekday(day, "long"), hour: String(hour).padStart(2, "0"), n: formatCount(count) });
        row.append(cell);
      });
      tbody.append(row);
    });
    table.append(thead, tbody);
    const scale = el("div", "heat-scale");
    scale.setAttribute("aria-hidden", "true");
    scale.append(el("span", "", "0"), el("i"), el("span", "", formatCount(peak)));
    section.append(table, scale);
    return section;
  }

  function durationCard(activity) {
    const { section } = card("durations", t("เวลาตรวจสอบ"),
      t("ตั้งแต่เวิร์กเกอร์เริ่มจนเสร็จ ไม่นับเวลารอในคิว"));
    const timed = activity ? activity.durations.reduce((sum, count) => sum + count, 0) : 0;
    if (!timed) {
      section.append(el("p", "chart-empty", activity ? t("ยังไม่มีการบันทึกเวลาในช่วงนี้")
        : t("ไม่มีข้อมูลกิจกรรม ระบบจะลองใหม่อัตโนมัติ")));
      return section;
    }
    const average = averageDuration(activity.current);
    const earlier = averageDuration(activity.previous);
    const layout = el("div", "donut-layout");
    const donut = el("div", "donut");
    const svg = svgNode("svg", { viewBox: "0 0 120 120", "aria-hidden": "true" });
    const radius = 50;
    const around = 2 * Math.PI * radius;
    const gap = 1.4;
    let offset = 0;
    activity.durations.forEach((count, index) => {
      const length = count / timed * around;
      // Leave a surface gap between segments instead of drawing a border.
      if (length > gap) {
        svg.append(svgNode("circle", {
          class: `donut-part ramp-${index + 1}`, cx: 60, cy: 60, r: radius,
          "stroke-dasharray": `${(length - gap).toFixed(2)} ${(around - length + gap).toFixed(2)}`,
          "stroke-dashoffset": (-offset - gap / 2).toFixed(2),
        }));
      }
      offset += length;
    });
    const center = el("div", "donut-center");
    center.dataset.metric = "average";
    center.append(el("span", "donut-caption", t("เวลาเฉลี่ย")),
      el("strong", "summary-value", average === null ? "—" : formatElapsed(average)));
    const delta = deltaNode(average === null || earlier === null ? null : average - earlier, secondsText, false);
    if (delta) center.append(delta);
    donut.append(svg, center);
    const legend = el("ul", "donut-legend");
    activity.durations.forEach((count, index) => {
      const item = el("li");
      item.dataset.bucket = String(index);
      item.title = t("{n} ครั้ง", { n: formatCount(count) });
      const swatch = el("i", `swatch ramp-${index + 1}`);
      swatch.setAttribute("aria-hidden", "true");
      item.append(swatch, el("span", "donut-label", DURATION_LABELS[index]),
        el("span", "donut-count", formatCount(count)), el("strong", "", `${(count * 100 / timed).toFixed(1)}%`));
      legend.append(item);
    });
    layout.append(donut, legend);
    section.append(layout);
    return section;
  }

  // ---- Overview: errors, queue and coverage ----

  function errorsCard(activity) {
    const { section } = card("errors", t("ข้อผิดพลาดและการบล็อก"));
    const rows = el("div", "metric-rows compact");
    if (!activity) {
      const missing = t("ไม่มีข้อมูลจำนวนครั้ง");
      rows.append(metricRow("errors", t("ข้อผิดพลาดในการค้นหา", null, "Lookup errors"), "—", missing),
        metricRow("blocked", t("CAPTCHA / การบล็อก"), "—", missing),
        metricRow("retry", t("อัตราการลองซ้ำ"), "—", missing));
      section.append(rows);
      return section;
    }
    const { current, previous } = activity;
    const retry = rate(current.retry, current.n);
    rows.append(
      metricRow("errors", t("ข้อผิดพลาดในการค้นหา", null, "Lookup errors"), formatCount(current.err), null,
        deltaNode(current.err - previous.err, formatCount, false)),
      metricRow("blocked", t("CAPTCHA / การบล็อก"), formatCount(current.blk),
        t("ต้องขอความยินยอม {n} ครั้ง", { n: formatCount(activity.consent) }),
        deltaNode(current.blk - previous.blk, formatCount, false)),
      metricRow("retry", t("อัตราการลองซ้ำ"), retry.value, retry.detail),
    );
    section.append(rows, el("h4", "card-subtitle", t("รหัสข้อผิดพลาดที่พบบ่อย")));
    if (!activity.errors.length) {
      section.append(el("p", "card-note", t("ไม่มีรหัสข้อผิดพลาดในช่วงนี้")));
      return section;
    }
    const list = el("ul", "code-list");
    activity.errors.slice(0, 5).forEach(({ code, count }) => {
      const item = el("li");
      item.append(el("code", "", code), el("strong", "", formatCount(count)));
      list.append(item);
    });
    section.append(list);
    return section;
  }

  function queueCard(pending, scheduled, running, activity) {
    const { section } = card("queue", t("ภาพรวมคิว"), t("ภาพสถานะล่าสุดที่อัปโหลด ไม่ขึ้นกับช่วงวันที่"));
    section.dataset.metric = "queue";
    const headline = el("div", "card-figure");
    headline.append(el("p", "summary-value", formatCount(pending + scheduled)),
      el("p", "metric-note", t("{pending} รอดำเนินการ · {scheduled} กำหนดไว้", { pending: formatCount(pending), scheduled: formatCount(scheduled) })));
    const rows = [
      { key: "pending", label: t("รอดำเนินการ"), count: pending },
      { key: "scheduled", label: t("กำหนดไว้"), count: scheduled },
      { key: "running", label: t("กำลังทำงาน"), count: running },
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
    section.append(headline, list, el("p", "card-note", t("{n} กำลังทำงาน · รวมการตรวจซ้ำในอนาคต", { n: formatCount(running) })));
    // A rough pace: attempts include rechecks, so pending places can take longer.
    const days = activity && !rangeOffset ? (activity.range.end - activity.range.start) / DAY : 0;
    const pace = days ? activity.current.n / Math.max(days, 1 / 24) : 0;
    if (pending && pace >= 1) {
      const estimate = el("p", "card-note");
      estimate.dataset.metric = "eta";
      estimate.textContent = t("ที่อัตราของช่วงนี้ (ประมาณ {pace} ครั้งต่อวัน) รายการที่รอดำเนินการใช้เวลาอีกราว {days} วัน", {
        pace: formatCount(Math.round(pace)), days: formatCount(Math.max(1, Math.ceil(pending / pace))),
      });
      section.append(estimate);
    }
    return section;
  }

  function coverageCard(outcomes) {
    const { section } = card("coverage", t("ความครอบคลุมของสถานที่"), t("ผลลัพธ์ล่าสุดของแต่ละสถานที่ ไม่ขึ้นกับช่วงวันที่"));
    const counts = Object.fromEntries(Object.entries(outcomes || {}).map(([key, value]) => [key, wholeCount(value)]));
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    if (!total) {
      section.append(el("p", "chart-empty", t("ยังไม่มีรายงานสถานที่")));
      return section;
    }
    const named = ["found", "found_no_phone", "ambiguous", "not_found"];
    const parts = named.map((key) => ({ key, label: STATUS_LABELS[key], count: counts[key] || 0 }));
    const resolved = parts.reduce((sum, part) => sum + part.count, 0);
    parts.push({ key: "none", label: t("ยังไม่มีผลลัพธ์"), count: total - resolved });
    const share = (count) => count * 100 / total;
    const headline = el("div", "card-figure");
    headline.dataset.metric = "coverage";
    headline.append(el("p", "summary-value", `${share(resolved).toFixed(1)}%`),
      el("p", "metric-note", t("{a} จาก {b} สถานที่มีผลลัพธ์แล้ว", { a: formatCount(resolved), b: formatCount(total) })));
    const bar = el("div", "stack-bar");
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", parts.map((part) => `${part.label} ${formatCount(part.count)} (${share(part.count).toFixed(1)}%)`).join(", "));
    const legend = el("ul", "stack-legend");
    parts.forEach((part) => {
      if (part.count) {
        const block = el("span", `stack-part outcome-${part.key}`, share(part.count) >= 9 ? `${Math.round(share(part.count))}%` : "");
        block.style.flexGrow = String(part.count);
        block.title = `${part.label} · ${formatCount(part.count)} (${share(part.count).toFixed(1)}%)`;
        bar.append(block);
      }
      const item = el("li");
      item.dataset.outcome = part.key;
      const swatch = el("i", `swatch outcome-${part.key}`);
      swatch.setAttribute("aria-hidden", "true");
      item.append(swatch, el("span", "stack-label", part.label), el("span", "stack-count", formatCount(part.count)),
        el("strong", "", `${share(part.count).toFixed(1)}%`));
      legend.append(item);
    });
    section.append(headline, bar, legend);
    return section;
  }

  function workerStat(label, value, detail, percent) {
    const stat = el("div", "worker-stat");
    stat.append(el("div", "worker-stat-label", label), el("div", "worker-stat-value", value));
    if (percent !== undefined) {
      const meter = el("div", "meter");
      meter.setAttribute("aria-hidden", "true");
      const fill = el("span");
      fill.style.width = `${percent}%`;
      meter.append(fill);
      stat.append(meter);
    }
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
    const range = rangeWindow();
    const [result, activity] = await Promise.all([
      client.rpc("monitoring_overview", { p_worker_id: workerId || null }),
      fetchActivity(workerId, range),
    ]);
    if (!isCurrent()) return "";
    const data = resultOrThrow(result);
    if (!Array.isArray(data?.workers)) throw new Error(t("ไม่มีข้อมูลเวิร์กเกอร์"));
    workers = data.workers;
    if (workerId && !workers.some((worker) => worker.worker_id === workerId)) {
      setActiveWorker("");
      populateWorkers();
      await refreshCurrent();
      return "";
    }
    populateWorkers();
    syncRangeControls(range);
    const chosenWorkers = workerId ? workers.filter((worker) => worker.worker_id === workerId) : workers;
    const now = Date.now();
    const reporting = chosenWorkers.filter((worker) => heartbeatRecent(worker, now)).length;
    const paused = chosenWorkers.filter((worker) => worker.current_state?.pause_reason).length;
    const counts = data.queue_counts || {};
    const pending = wholeCount(counts.pending);
    const scheduled = wholeCount(counts.retry_wait);
    const running = wholeCount(counts.running);

    const content = document.createDocumentFragment();
    const dash = el("div", "dash");
    const top = el("div", "dash-row lead");
    top.append(keyMetricsCard(activity, range), trendCard(activity));
    const middle = el("div", "dash-row halves");
    middle.append(heatmapCard(activity), durationCard(activity));
    const bottom = el("div", "dash-row thirds");
    bottom.append(errorsCard(activity), queueCard(pending, scheduled, running, activity), coverageCard(data.outcome_counts));
    dash.append(top, middle, bottom);
    content.append(dash, el("p", "summary-note", t("ตัวชี้วัดและกราฟคำนวณจากการลองตรวจสอบที่เสร็จแล้วในช่วงวันที่ที่เลือก ตามเวลาท้องถิ่นของเบราว์เซอร์ ส่วนคิว ความครอบคลุม และเวิร์กเกอร์อ้างอิงภาพสถานะที่อัปโหลดล่าสุด")));

    const workerHeading = el("div", "worker-section-heading");
    const workerIntro = el("div");
    const workerSummary = el("p", "worker-summary");
    workerSummary.dataset.metric = "workers";
    workerSummary.append(
      el("strong", "summary-value", chosenWorkers.length ? `${formatCount(reporting)} / ${formatCount(chosenWorkers.length)}` : "—"),
      el("span", "", chosenWorkers.length ? t("ได้รับสัญญาณชีพล่าสุด") : t("ยังไม่มีเวิร์กเกอร์")),
      el("span", "worker-summary-detail", chosenWorkers.length
        ? t("{a} ไม่มีสัญญาณชีพล่าสุด · {b} รายงานว่าหยุดทำงานล่าสุด", { a: formatCount(chosenWorkers.length - reporting), b: formatCount(paused) })
        : t("กำลังรอข้อมูลเวิร์กเกอร์")),
    );
    workerIntro.append(el("h2", "worker-section-title", t("เวิร์กเกอร์", null, "Workers")), workerSummary);
    workerHeading.append(workerIntro, el("p", "worker-section-note", t("สัญญาณชีพที่ได้รับภายใน 10 นาทีล่าสุด")));
    content.append(workerHeading);

    if (!chosenWorkers.length) content.append(el("p", "empty panel", t("ยังไม่มีการตั้งค่าเวิร์กเกอร์ Scraper")));
    chosenWorkers.forEach((worker) => {
      const state = worker.current_state || {};
      const recent = heartbeatRecent(worker, now);
      const runStatus = recent ? t("สัญญาณชีพล่าสุด", null, "Heartbeat recent") : t("เวิร์กเกอร์ไม่รายงานสถานะ");
      const runBadge = el("span", `badge${recent ? "" : " warning"}`, runStatus);
      const section = el("section", "worker-panel");
      const header = el("div", "worker-head");
      const identity = el("div", "worker-identity");
      const avatar = el("span", "worker-avatar", workerLabel(worker).slice(0, 1).toUpperCase());
      avatar.setAttribute("aria-hidden", "true");
      const identityText = el("div");
      identityText.append(el("h3", "worker-name", workerLabel(worker)), el("p", "worker-id", t("รหัสเวิร์กเกอร์ {id}", { id: worker.worker_id })));
      identity.append(avatar, identityText);
      const badges = el("div", "worker-badges");
      badges.append(runBadge);
      if (state.pause_reason) badges.append(el("span", "badge error", t("รายงานว่าหยุดทำงานล่าสุด: {reason}", { reason: state.pause_reason })));
      else if (state.state_event_type === "queue_resumed") badges.append(el("span", "badge", t("กลับมาทำงานต่อแล้ว")));
      else if (state.state_event_type === "run_ended") badges.append(el("span", "badge", t("รอบทำงานสิ้นสุดแล้ว")));
      header.append(identity, badges);
      section.append(header);

      const usage = state.daily_usage != null ? `${formatCount(state.daily_usage)} / ${state.daily_limit == null ? "—" : formatCount(state.daily_limit)}` : "—";
      const usageShare = state.daily_usage != null && Number(state.daily_limit) > 0
        ? Math.min(100, Math.max(0, Number(state.daily_usage) * 100 / Number(state.daily_limit))) : undefined;
      const day = state.bangkok_day ? t("วันที่ตามเวลาไทย {day}", { day: state.bangkok_day }) : t("ยังไม่มีรายงานการใช้งาน");
      const current = state.current_job ? `${state.current_job.name || t("สถานที่ไม่มีชื่อ")} · ${state.current_job.osm_id || "—"}` : t("ยังไม่มีรายงานการค้นหา");
      const exit = worker.last_exit ? `${STATUS_LABELS[worker.last_exit.outcome] || worker.last_exit.outcome || t("รายงานการสิ้นสุด")}${worker.last_exit.reason ? ` · ${worker.last_exit.reason}` : ""}` : t("ยังไม่มีรายงานการสิ้นสุดรอบทำงาน");
      const queue = state.queue_counts || {};
      const queueLine = Object.entries(queue).map(([name, count]) => `${STATUS_LABELS[name] || name}: ${formatCount(count)}`).join(" · ") || t("ยังไม่มีรายงานจำนวนในคิว");
      const stats = el("div", "worker-stats");
      stats.append(
        workerStat(t("การใช้งานรายวัน / ขีดจำกัด"), usage, day, usageShare),
        workerStat(t("การค้นหาที่รายงานล่าสุด"), current, t("รออัปโหลด: {n}", { n: state.pending_upload_count == null ? "—" : formatCount(state.pending_upload_count) })),
        workerStat(t("สัญญาณชีพล่าสุด"), formatDate(worker.last_heartbeat_at), recent ? t("ได้รับภายใน 10 นาที") : t("ไม่ได้รับสัญญาณชีพล่าสุด")),
        workerStat(t("อัปโหลดล่าสุด"), formatDate(worker.last_upload_at), t("พบล่าสุด {date}", { date: formatDate(worker.last_seen_at) })),
      );
      section.append(stats);
      const detail = el("div", "worker-meta");
      const lastExit = worker.last_exit || {};
      const safety = Number(lastExit.safety_sequence || 0) > Number(state.safety_sequence || state.state_sequence || 0)
        ? lastExit.safety : state.safety;
      const recentErrors = safety && safety.recent_temporary_errors != null && safety.recent_attempts != null
        ? t("{a} / {b} ครั้งล่าสุด · เกิดต่อเนื่อง {c} ครั้ง", { a: formatCount(safety.recent_temporary_errors), b: formatCount(safety.recent_attempts), c: formatCount(safety.consecutive_temporary_errors) })
        : t("ยังไม่มีรายงาน");
      detail.append(el("span", "", t("คิว: {value}", { value: queueLine })), el("span", "", t("รายงานการสิ้นสุดล่าสุด: {value}", { value: exit })),
        el("span", "", t("ข้อผิดพลาดชั่วคราว: {value}", { value: recentErrors })));
      section.append(detail);
      content.append(section);
    });

    // A refresh replaces the cards; keep the reader's place in them.
    const focusedId = container.contains(document.activeElement) ? document.activeElement.id : "";
    const openIds = Array.from(container.querySelectorAll("details[open][id]"), (details) => details.id);
    container.replaceChildren(content);
    openIds.forEach((id) => {
      const details = document.getElementById(id);
      if (details) details.open = true;
    });
    if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
    return activity ? "" : t("ไม่มีข้อมูลกิจกรรม ระบบจะลองใหม่อัตโนมัติ");
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
      setLogDateError(t("กรุณาระบุวันที่เริ่มต้นและวันที่สิ้นสุดให้ถูกต้อง"));
      return;
    }
    if (fromTime !== null && toTime !== null && fromTime > toTime) {
      setLogDateError(t("วันที่เริ่มต้นต้องไม่อยู่หลังวันที่สิ้นสุด"));
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
      const loading = el("p", "chart-empty", t("กำลังโหลดเวลาตรวจสอบ…"));
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
          ? t("ยังไม่มีเวลาตรวจสอบที่เสร็จแล้วสำหรับสถานที่เหล่านี้")
          : t("ไม่มีสถานที่ให้เปรียบเทียบในหน้านี้")));
        if (hadFocus) document.getElementById("place-time-title").focus({ preventScroll: true });
        return "";
      }
      const maximum = Math.max(...durations.map(({ elapsed }) => elapsed));
      const list = el("ol", "place-time-list");
      list.tabIndex = 0;
      list.setAttribute("aria-label", t("เวลาตรวจสอบ เรียงจากนานที่สุด"));
      durations.forEach(({ place, attempt, elapsed }) => {
        const item = el("li", "place-time-item");
        item.dataset.osmId = place.osm_id;
        item.dataset.workerId = place.worker_id;
        const heading = el("div", "place-time-heading");
      const label = el("span", "place-time-label", place.source_record?.name || t("(ไม่มีชื่อ)"));
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
      const note = el("p", "place-time-note", t("{d} จาก {p} สถานที่ มีการบันทึกเวลา เรียงจากนานที่สุด{missing}", {
        d: formatCount(durations.length), p: formatCount(places.length), dn: durations.length, pn: places.length,
        missing: missing ? t(" · ไม่มีข้อมูล {m} แห่ง", { m: formatCount(missing) }) : "",
      }));
      container.replaceChildren(list, note);
      if (list.scrollHeight > list.clientHeight) note.textContent += t(" · เลื่อนเพื่อดูทั้งหมด");
      if (hadFocus) {
        list.focus({ preventScroll: true });
        list.scrollTop = scrollTop;
      }
      return "";
    } catch {
      if (!isCurrent()) return "";
      const hadFocus = container.contains(document.activeElement);
      const message = el("p", "chart-empty", t("โหลดเวลาตรวจสอบไม่สำเร็จ"));
      const retry = el("button", "secondary", t("ลองโหลดกราฟอีกครั้ง"));
      retry.type = "button";
      retry.addEventListener("click", () => {
        document.getElementById("place-time-title").focus({ preventScroll: true });
        refreshCurrent();
      });
      container.replaceChildren(message, retry);
      if (hadFocus) retry.focus({ preventScroll: true });
      return t("กราฟเวลาตรวจสอบไม่พร้อมใช้งาน ระบบจะลองใหม่อัตโนมัติ");
    } finally {
      if (isCurrent()) container.removeAttribute("aria-busy");
    }
  }

  async function fetchPlacesPage(filters, workerId, offset, full = false) {
    const { query, outcome, queueStatus, review } = filters;
    const params = {
      p_query: query,
      p_outcome: outcome,
      p_queue_status: queueStatus,
      p_worker_id: workerId || null,
      p_review_flag: review,
      p_limit: PAGE_SIZE,
    };
    // The RPC's SQL ILIKE accepts wildcards and PostgREST has its own filter
    // grammar. Preserve the original search behavior for anything outside this
    // conservative set of ordinary search characters.
    const search = Array.from(query).slice(0, 200).join("");
    const useRpc = !/^[\p{L}\p{M}\p{N}\s/-]*$/u.test(search);
    if (useRpc) return client.rpc("monitoring_places_page", { ...params, p_offset: offset });
    let request = client.from("monitoring_place_results")
      .select(full ? PLACE_EXPORT_FIELDS.join(",") : "worker_id,osm_id,name:source_record->>name,outcome,queue_status,review_flag,latest_error_code,latest_attempt_id", { count: "exact" })
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
    return { data: { total: result.count, rows: full ? result.data : (result.data || []).map((place) => ({
      ...place, source_record: { name: place.name },
    })) }, error: null };
  }

  async function renderPlaces(isCurrent) {
    const { query, outcome, queueStatus, review } = placeFilters;
    const fetchPage = (offset) => fetchPlacesPage(placeFilters, activeWorker, offset);
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
      const name = place.source_record?.name || t("(ไม่มีชื่อ)");
      const button = el("button", "link", name);
      button.type = "button";
      button.dataset.focusKey = JSON.stringify([place.worker_id, place.osm_id]);
      button.addEventListener("click", () => openDetail(place));
      return [button, place.worker_id.slice(0, 8), place.osm_id, pill(place.outcome), pill(place.queue_status), place.review_flag ? pill("warning", "needs review") : "—", place.latest_error_code || "—"];
    });
    const filtered = query || outcome || queueStatus || review !== null || activeWorker;
    const emptyMessage = filtered
      ? t("ไม่พบสถานที่ที่ตรงกับตัวกรองปัจจุบัน ลองปรับตัวกรองหรือเลือกเวิร์กเกอร์อื่น")
      : t("ยังไม่มีรายงานสถานที่");
    replaceTable(document.getElementById("places-table"), makeTable(
      [t("ชื่อ"), t("เวิร์กเกอร์"), "OSM ID", t("ผลลัพธ์"), t("คิว"), t("ตรวจทาน"), t("ข้อผิดพลาดล่าสุด")], rows, t("ตารางสถานที่"), emptyMessage,
    ));
    setPager("places", offset, placesTotal,
      () => { placesOffset = Math.max(0, offset - PAGE_SIZE); refreshCurrent(); },
      () => { placesOffset = offset + PAGE_SIZE; refreshCurrent(); });
    return renderPlaceTimes(places, JSON.stringify([activeWorker, placeFilters, offset]), isCurrent);
  }

  function csvValue(value) {
    // Bare empty fields are SQL NULL in PostgreSQL CSV; quoted empty fields are empty strings.
    if (value == null) return "";
    const checkPrecision = (item) => {
      if (typeof item === "number" && Number.isInteger(item) && !Number.isSafeInteger(item)) {
        throw new Error(t("ตัวเลขบางรายการมีขนาดเกินความแม่นยำของเบราว์เซอร์ โปรดส่งออกจากฐานข้อมูลโดยตรง"));
      }
      if (item && typeof item === "object") Object.values(item).forEach(checkPrecision);
    };
    checkPrecision(value);
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    return `"${text.replace(/"/g, '""')}"`;
  }

  async function exportPlaces() {
    if (!client) return;
    const button = document.getElementById("export-places");
    if (button.disabled) return;
    const status = document.getElementById("place-export-status");
    const filters = { ...placeFilters };
    const workerId = activeWorker;
    const parts = [`${PLACE_EXPORT_FIELDS.join(",")}\r\n`];
    const keys = new Set();
    let total = null;
    button.disabled = true;
    status.classList.remove("error");
    status.textContent = t("กำลังรวบรวมข้อมูล {n} จาก {total} รายการ…", { n: 0, total: "…" });
    try {
      for (let offset = 0; total === null || offset < total; offset += PAGE_SIZE) {
        const data = resultOrThrow(await fetchPlacesPage(filters, workerId, offset, true));
        const pageTotal = data?.total;
        const rows = data?.rows;
        if (!Number.isSafeInteger(pageTotal) || pageTotal < 0 || !Array.isArray(rows) ||
            (total !== null && pageTotal !== total) || rows.length !== Math.min(PAGE_SIZE, Math.max(0, pageTotal - offset))) {
          throw new Error(t("ข้อมูลเปลี่ยนระหว่างส่งออก กรุณาลองอีกครั้ง"));
        }
        total = pageTotal;
        rows.forEach((place) => {
          const key = JSON.stringify([place.worker_id, place.osm_id]);
          if (!place.worker_id || !place.osm_id || keys.has(key)) {
            throw new Error(t("ข้อมูลเปลี่ยนระหว่างส่งออก กรุณาลองอีกครั้ง"));
          }
          keys.add(key);
          parts.push(`${PLACE_EXPORT_FIELDS.map((field) => csvValue(place[field])).join(",")}\r\n`);
        });
        status.textContent = t("กำลังรวบรวมข้อมูล {n} จาก {total} รายการ…", { n: formatCount(keys.size), total: formatCount(total) });
      }
      if (!total) {
        status.textContent = t("ไม่พบข้อมูลที่ตรงกับตัวกรองที่ใช้แล้ว จึงไม่มีไฟล์ให้ดาวน์โหลด");
        return;
      }
      const url = URL.createObjectURL(new Blob(parts, { type: "text/csv;charset=utf-8" }));
      const link = el("a");
      link.href = url;
      link.download = `monitoring-places-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      status.textContent = t("ดาวน์โหลดข้อมูลมอนิเตอร์ {n} รายการแล้ว", { n: formatCount(total) });
    } catch (error) {
      status.classList.add("error");
      status.textContent = errorText(error, t("ส่งออกข้อมูลไม่สำเร็จ กรุณาลองอีกครั้ง"));
    } finally {
      button.disabled = false;
    }
  }

  function openDetail(place) {
    detailRequest += 1;
    detailPlace = place;
    detailPlaceLoaded = false;
    detailOpenerKey = JSON.stringify([place.worker_id, place.osm_id]);
    attemptsOffset = 0;
    document.getElementById("detail-title").textContent = `${place.source_record?.name || t("สถานที่", null, "Place")} · ${place.osm_id}`;
    document.getElementById("detail-error").textContent = "";
    const retry = document.getElementById("detail-retry");
    retry.hidden = true;
    retry.disabled = false;
    const loading = el("p", "muted detail-loading", t("กำลังโหลดรายละเอียดสถานที่…"));
    loading.setAttribute("role", "status");
    document.getElementById("detail-content").replaceChildren(loading);
    document.getElementById("attempts-table").replaceChildren();
    document.getElementById("attempts-page").textContent = t("กำลังโหลด…");
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
        if (!place) throw new Error(t("ไม่พบรายละเอียดสถานที่นี้แล้ว"));
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
        detailPanel(t("ข้อมูลต้นทาง OSM"), place.source_record),
        detailPanel(pendingReview ? t("รายการที่ใกล้ที่สุดที่แนะนำ — รอตรวจทาน") :
          reviewed ? t("รายการ Google ที่ใกล้ที่สุดและตรวจทานแล้ว") : t("ข้อเสนอ Google ที่สำเร็จล่าสุด"), place.google_proposal),
      );
      const content = document.createDocumentFragment();
      if (pendingReview) content.append(el("p", "muted", t("รายการแนะนำนี้จะไม่ถูกรวมในการส่งออกผลลัพธ์ปกติจนกว่าจะอนุมัติบนเซิร์ฟเวอร์ Scraper แต่จะอยู่ในข้อมูลมอนิเตอร์ดิบ ใช้รายการตรวจทานเพื่อค้นหา ID")));
      content.append(columns, detailPanel(t("ตัวเลือกที่ตรงกันล่าสุด"), place.candidates));
      content.append(el("p", "muted", t("วิธีจับคู่: {method} · ความคล้ายคลึง: {similarity} · ระยะทาง: {distance} ม. · เครื่องหมายตรวจทาน: {flag}", { method: place.matching_method || "—", similarity: place.similarity ?? "—", distance: place.distance_m ?? "—", flag: place.review_flag ? t("มี") : t("ไม่มี") })));
      if (place.latest_error_code || place.latest_error_message) {
        const error = el("div", "panel");
        error.append(el("strong", "", t("ข้อผิดพลาดล่าสุด {code}", { code: place.latest_error_code || "" })));
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
        [t("เสร็จเมื่อ"), t("ระยะเวลา"), t("สถานะ"), t("ผลลัพธ์"), t("การจับคู่"), t("ข้อผิดพลาดล่าสุด"), t("หลักฐาน")], rows,
        t("ตารางประวัติการลองตรวจสอบ"), t("ยังไม่มีรายงานการลองตรวจสอบสำหรับสถานที่นี้"),
      ));
      setPager("attempts", offset, attemptsTotal,
        () => { attemptsOffset = Math.max(0, offset - PAGE_SIZE); refreshDetail(); },
        () => { attemptsOffset = offset + PAGE_SIZE; refreshDetail(); });
      if (options.status === undefined && status === statusRequest) setError("");
      return true;
    } catch (error) {
      if (isCurrent()) {
        const message = errorText(error, t("โหลดรายละเอียดสถานที่ไม่สำเร็จ"));
        document.getElementById("detail-error").textContent = message;
        retry.hidden = false;
        const loading = document.querySelector("#detail-content .detail-loading");
        if (loading) {
          loading.textContent = t("โหลดรายละเอียดสถานที่ไม่สำเร็จ กรุณาลองอีกครั้ง");
          document.getElementById("attempts-page").textContent = t("ไม่พร้อมใช้งาน");
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
    const summary = el("summary", "", t("ดูรายละเอียด"));
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
      const loading = el("p", "muted", t("กำลังโหลดรายละเอียด…"));
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
        const message = el("p", "field-error", errorText(error, t("โหลดรายละเอียดไม่สำเร็จ")));
        message.setAttribute("role", "alert");
        const retry = el("button", "secondary", t("ลองโหลดรายละเอียดอีกครั้ง"));
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
      label: t("ดูหลักฐานของการลองตรวจสอบที่เสร็จเมื่อ {date}", { date: formatDate(attempt.worker_completed_at) }),
      load: async () => {
        const result = await client.from("monitoring_attempts").select("candidates,proposal,errors")
          .eq("worker_id", workerId).eq("attempt_id", attempt.attempt_id).maybeSingle();
        const evidence = resultOrThrow(result);
        if (!evidence) throw new Error(t("ไม่พบหลักฐานการลองตรวจสอบนี้แล้ว"));
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
      ? t("ไม่พบเหตุการณ์ที่ตรงกับตัวกรองปัจจุบัน ลองปรับตัวกรองหรือเลือกเวิร์กเกอร์อื่น")
      : t("ยังไม่ได้รับเหตุการณ์การทำงาน");
    replaceTable(document.getElementById("logs-table"), makeTable(
      [t("เวลาที่ได้รับ"), t("ระดับ"), t("เหตุการณ์"), t("เวิร์กเกอร์"), t("รอบทำงาน"), t("รายละเอียด")], rows, t("ตารางบันทึกเหตุการณ์"), emptyMessage,
    ));
    setPager("logs", offset, logsTotal,
      () => { logsOffset = Math.max(0, offset - PAGE_SIZE); refreshCurrent(); },
      () => { logsOffset = offset + PAGE_SIZE; refreshCurrent(); });
  }

  function jsonDisclosure(event) {
    const key = event.event_id;
    return lazyDisclosure({
      key, loadKey: `event:${key}`, cache: eventDetails,
      label: t("ดูรายละเอียด {event} ที่ได้รับเมื่อ {date}", { event: eventLabel(event.event_type), date: formatDate(event.received_at) }),
      load: async () => {
        const result = await client.from("monitoring_operational_events").select("data")
          .eq("event_id", key).maybeSingle();
        const row = resultOrThrow(result);
        if (!row) throw new Error(t("ไม่พบรายละเอียดบันทึกเหตุการณ์นี้แล้ว"));
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
    if (placeholder) placeholder.textContent = t("กำลังโหลด{name}…", { name: viewName(view) });
    setLive("", t("กำลังอัปเดต…"));
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
        if (placeholder) placeholder.textContent = t("โหลด{name}ไม่สำเร็จ กดรีเฟรชตอนนี้เพื่อลองอีกครั้ง", { name: viewName(view) });
        setError(errorText(error, t("โหลดข้อมูลมอนิเตอร์ไม่สำเร็จ")));
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
    setLive("", t("กำลังอัปเดต…"));
    try {
      if (view === "overview" || await refreshWorkers(isCurrent)) await refreshCurrent();
    } catch (error) {
      if (isCurrent() && status === statusRequest) {
        const placeholder = document.querySelector(`#${activeView}-view .view-placeholder`);
        if (placeholder) placeholder.textContent = t("โหลด{name}ไม่สำเร็จ กดรีเฟรชตอนนี้เพื่อลองอีกครั้ง", { name: viewName(activeView) });
        setError(errorText(error, t("รีเฟรชข้อมูลไม่สำเร็จ")));
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
    syncRangeControls();
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
    announcement.textContent = t("กำลังรีเฟรชแดชบอร์ด…");
    await refreshAll();
    if (request !== manualRefresh || document.hidden) return;
    const live = document.getElementById("live-status");
    announcement.textContent = live.classList.contains("ok") ? t("อัปเดตแดชบอร์ดแล้ว")
      : live.classList.contains("warning") ? t("อัปเดตแดชบอร์ดแล้ว แต่ข้อมูลบางรายการไม่พร้อมใช้งาน") : "";
  });
  const themeToggle = document.getElementById("theme-toggle");
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  function isDarkTheme() {
    const selected = document.documentElement.dataset.theme;
    return selected === "dark" || (selected !== "light" && systemTheme.matches);
  }
  function updateThemeToggle() {
    const dark = isDarkTheme();
    const label = dark ? t("เปลี่ยนเป็นธีมสว่าง") : t("เปลี่ยนเป็นธีมมืด");
    themeToggle.setAttribute("aria-label", label);
    themeToggle.title = label;
    document.getElementById("theme-icon-moon").toggleAttribute("hidden", dark);
    document.getElementById("theme-icon-sun").toggleAttribute("hidden", !dark);
  }
  updateThemeToggle();
  systemTheme.addEventListener("change", updateThemeToggle);
  function toggleTheme(persist = true) {
    const root = document.documentElement;
    root.dataset.theme = isDarkTheme() ? "light" : "dark";
    if (persist) {
      try { localStorage.setItem("theme", root.dataset.theme); } catch { /* storage unavailable */ }
    }
    updateThemeToggle();
  }
  themeToggle.addEventListener("click", () => toggleTheme());
  const themeLoopToggle = document.getElementById("theme-loop-toggle");
  let themeLoopTimer = null;
  themeLoopToggle.addEventListener("click", () => {
    const running = themeLoopTimer === null;
    if (running) themeLoopTimer = window.setInterval(() => toggleTheme(false), 100);
    else {
      window.clearInterval(themeLoopTimer);
      themeLoopTimer = null;
    }
    themeLoopToggle.setAttribute("aria-pressed", String(running));
    const label = running ? t("หยุดสลับธีม") : t("เริ่มสลับธีมทุก 250 มิลลิวินาที");
    themeLoopToggle.setAttribute("aria-label", label);
    themeLoopToggle.title = label;
  });
  const langToggle = document.getElementById("lang-toggle");
  const nextLang = I18N.lang === "en" ? "th" : "en";
  langToggle.textContent = nextLang === "en" ? "EN" : "ไทย";
  const langLabel = nextLang === "en" ? t("เปลี่ยนเป็นภาษาอังกฤษ") : t("เปลี่ยนเป็นภาษาไทย");
  langToggle.title = langLabel;
  langToggle.setAttribute("aria-label", langLabel);
  langToggle.addEventListener("click", () => I18N.setLang(nextLang));
  document.getElementById("range-preset").addEventListener("change", (event) => setRange(Number(event.target.value), 0));
  document.getElementById("range-prev").addEventListener("click", () => setRange(rangeDays, rangeOffset + 1));
  document.getElementById("range-next").addEventListener("click", () => setRange(rangeDays, rangeOffset - 1));
  syncRangeControls();
  document.getElementById("active-worker").addEventListener("change", (event) => {
    setActiveWorker(event.target.value);
    refreshCurrent();
  });
  document.getElementById("log-worker").addEventListener("change", (event) => {
    setActiveWorker(event.target.value);
    refreshCurrent();
  });
  document.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  document.getElementById("export-places").addEventListener("click", exportPlaces);
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
    document.querySelector("#overview-view .view-placeholder").textContent = t("โหลดภาพรวมไม่สำเร็จ โหลดหน้าเว็บอีกครั้งเพื่อลองใหม่");
    setError(t("โหลดไลบรารี Supabase สำหรับเบราว์เซอร์ไม่สำเร็จ"));
    return;
  }
  if (!config.supabaseUrl || !config.supabasePublishableKey) {
    document.querySelector("#overview-view .view-placeholder").textContent = t("โหลดภาพรวมไม่สำเร็จ ตรวจสอบการตั้งค่าแดชบอร์ดแล้วโหลดหน้าเว็บอีกครั้ง");
    setError(t("คัดลอก config.example.js เป็น config.js แล้วเพิ่ม Supabase URL และ publishable key"));
    return;
  }
  // Read-only public access: the anon role is limited to SELECT by migration 0002.
  client = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  document.getElementById("export-places").disabled = false;
  startApp();
})();
