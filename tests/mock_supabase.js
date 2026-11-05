(() => {
  const workerA = "11111111-1111-1111-1111-111111111111";
  const workerB = "22222222-2222-2222-2222-222222222222";
  const makePlace = (worker_id, number, name) => ({
    worker_id,
    osm_id: `node/${number}`,
    source_record: { name },
    outcome: "found",
    queue_status: "checked",
    review_flag: false,
  });
  const state = {
    workerA,
    workerB,
    workers: [
      { worker_id: workerA, display_name: "Worker A", last_heartbeat_at: new Date(Date.now() - 30_000).toISOString(),
        last_upload_at: new Date(Date.now() - 20_000).toISOString(), current_state: { daily_usage: 128, daily_limit: 500, bangkok_day: "2026-11-03", pending_upload_count: 2 } },
      { worker_id: workerB, display_name: "Worker B", last_heartbeat_at: new Date(Date.now() - 700_000).toISOString(),
        current_state: { pause_reason: "BLOCKED", pending_upload_count: 0 }, last_exit: { outcome: "paused", reason: "BLOCKED" } },
    ],
    places: Array.from({ length: 101 }, (_, index) => {
      const number = String(index).padStart(3, "0");
      return makePlace(workerA, number, `Place ${number}`);
    }).concat([makePlace(workerB, "b", "Worker B place")]),
    logs: Array.from({ length: 101 }, (_, index) => ({
      event_id: `event-${index}`,
      worker_id: workerA,
      event_type: `Event ${String(index).padStart(3, "0")}`,
      severity: "info",
      data: {},
      received_at: "2026-01-01T00:00:00Z",
    })).concat([{
      event_id: "event-b",
      worker_id: workerB,
      event_type: "Worker B event",
      severity: "warning",
      data: {},
      received_at: "2026-01-01T00:00:00Z",
    }]),
    attempts: Array.from({ length: 101 }, (_, index) => ({
      worker_id: workerA,
      osm_id: "node/000",
      attempt_id: `attempt-${index}`,
      status: "checked",
      outcome: "found",
      error_code: `Attempt ${String(index).padStart(3, "0")}`,
      worker_completed_at: new Date(Date.now() - 60_000).toISOString(),
    })),
    requests: [],
  };
  state.places.slice(60, 80).forEach((place) => { place.queue_status = "pending"; });
  state.places.slice(80, 90).forEach((place) => { place.queue_status = "retry_wait"; });
  state.places.slice(90, 92).forEach((place) => { place.queue_status = "running"; });
  const heldKinds = [];
  const pending = new Map();
  let nextRequest = 0;

  function submit(kind, params, result) {
    const request = { id: ++nextRequest, kind, params: structuredClone(params),
      bodyBytes: new TextEncoder().encode(JSON.stringify(result.data)).length };
    state.requests.push(request);
    const snapshot = structuredClone(result);
    const holdIndex = heldKinds.indexOf(kind);
    if (holdIndex < 0) return Promise.resolve(snapshot);
    heldKinds.splice(holdIndex, 1);
    return new Promise((resolve) => pending.set(request.id, { request, snapshot, resolve }));
  }

  function matches(row, filters, ranges = {}, choices = {}) {
    return Object.entries(filters).every(([name, value]) => row[name] === value) &&
      Object.entries(choices).every(([name, values]) => values.includes(row[name])) &&
      Object.entries(ranges).every(([name, bounds]) => {
        if (row[name] == null) return false;
        const actual = new Date(row[name]).getTime();
        return Number.isFinite(actual) &&
          (!bounds.gte || actual >= new Date(bounds.gte).getTime()) &&
          (!bounds.lte || actual <= new Date(bounds.lte).getTime());
      });
  }

  function matchesLike(value, search) {
    const pattern = Array.from(`%${Array.from(search).slice(0, 200).join("")}%`);
    let regex = "^";
    const escape = (char) => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (let index = 0; index < pattern.length; index += 1) {
      const char = pattern[index];
      if (char === "\\" && index + 1 < pattern.length) regex += escape(pattern[++index]);
      else if (char === "%") regex += ".*";
      else if (char === "_") regex += ".";
      else regex += escape(char);
    }
    return new RegExp(`${regex}$`, "isu").test(String(value ?? ""));
  }

  function query(table) {
    const filters = {};
    const ranges = {};
    const choices = {};
    let head = false;
    let columns = "*";
    let search = "";
    let timePairs = null;
    let offset = 0;
    let limit = 50;
    function project(row) {
      if (!row || columns === "*") return row;
      return Object.fromEntries(columns.split(",").map((column) => {
        if (column === "name:source_record->>name") return ["name", row.source_record?.name ?? null];
        return [column, row[column] ?? null];
      }));
    }
    const builder = {
      select(value, options) { columns = value; head = options?.head === true; return builder; },
      order() { return builder; },
      eq(name, value) { filters[name] = value; return builder; },
      in(name, values) { choices[name] = values; return builder; },
      or(value) {
        if (table === "monitoring_attempts") {
          const groups = Array.from(value.matchAll(/and\(worker_id\.eq\.([0-9a-f-]+),attempt_id\.in\.\(([0-9a-f,-]+)\)\)/gi));
          if (!groups.length || groups.map((group) => group[0]).join(",") !== value) {
            throw new Error("Unexpected attempt timing filter");
          }
          timePairs = groups.flatMap((group) => group[2].split(",").map((attempt_id) => ({
            worker_id: group[1], attempt_id,
          })));
          return builder;
        }
        const match = /^osm_id\.ilike\.\*([^*]*)\*,source_record->>name\.ilike\.\*([^*]*)\*$/u.exec(value);
        if (!match || match[1] !== match[2]) throw new Error(`Unexpected search filter: ${value}`);
        search = match[1];
        return builder;
      },
      gte(name, value) { (ranges[name] ||= {}).gte = value; return builder; },
      lte(name, value) { (ranges[name] ||= {}).lte = value; return builder; },
      range(start, end) { offset = start; limit = end - start + 1; return builder; },
      maybeSingle() {
        const [kind, source] = table === "monitoring_place_results" ? ["place-detail", state.places]
          : table === "monitoring_attempts" ? ["attempt-evidence", state.attempts]
          : table === "monitoring_operational_events" ? ["log-detail", state.logs]
          : [null, null];
        if (!source) throw new Error(`Unexpected single-row table: ${table}`);
        const row = source.find((entry) => matches(entry, filters)) || null;
        return submit(kind, { filters, columns }, { data: project(row), error: null });
      },
      then(resolve, reject) {
        let kind;
        let rows;
        if (table === "monitoring_workers") {
          kind = "workers";
          rows = state.workers;
        } else if (table === "monitoring_place_results") {
          kind = "places";
          const text = search.toLowerCase();
          rows = state.places.filter((row) => matches(row, filters, ranges, choices) &&
            (!text || row.osm_id.toLowerCase().includes(text) || String(row.source_record?.name || "").toLowerCase().includes(text)));
        } else if (table === "monitoring_operational_events") {
          kind = "logs";
          rows = state.logs.filter((row) => matches(row, filters, ranges, choices));
        } else if (table === "monitoring_attempts") {
          if (!head) kind = timePairs ? "place-times" : "attempts";
          else if (choices.outcome) kind = "metric-matched";
          else if (filters.error_code === "BLOCKED") kind = "metric-blocked";
          else if (filters.error_code === "CONSENT_REQUIRED") kind = "metric-consent";
          else if (filters.status === "retry_wait") kind = "metric-retry";
          else kind = "metric-total";
          rows = state.attempts.filter((row) => matches(row, filters, ranges, choices) &&
            (!timePairs || timePairs.some((pair) => pair.worker_id === row.worker_id && pair.attempt_id === row.attempt_id)));
        } else {
          throw new Error(`Unexpected table: ${table}`);
        }
        return submit(kind, { filters, ranges, choices, head, offset, limit, columns, p_query: search, via: "table", timePairs }, {
          data: head ? null : (kind === "workers" ? rows : rows.slice(offset, offset + limit)).map(project),
          count: rows.length,
          error: null,
        }).then(resolve, reject);
      },
    };
    return builder;
  }

  const client = {
    from: query,
    rpc(name, params) {
      if (name === "monitoring_overview") {
        const rows = state.places.filter((place) => !params.p_worker_id || place.worker_id === params.p_worker_id);
        const queue_counts = {};
        rows.forEach((place) => { queue_counts[place.queue_status] = (queue_counts[place.queue_status] || 0) + 1; });
        return submit("overview", params, { data: { workers: state.workers, queue_counts, outcome_counts: {} }, error: null });
      }
      if (name !== "monitoring_places_page") throw new Error(`Unexpected RPC: ${name}`);
      const rows = state.places.filter((place) =>
        (!params.p_worker_id || place.worker_id === params.p_worker_id) &&
        (!params.p_query || matchesLike(place.osm_id, params.p_query) || matchesLike(place.source_record?.name, params.p_query)) &&
        (!params.p_outcome || place.outcome === params.p_outcome) &&
        (!params.p_queue_status || place.queue_status === params.p_queue_status) &&
        (params.p_review_flag === null || place.review_flag === params.p_review_flag));
      return submit("places", { ...params, via: "rpc" }, {
        data: { total: rows.length, rows: rows.slice(params.p_offset, params.p_offset + params.p_limit) },
        error: null,
      });
    },
  };

  const realSetInterval = window.setInterval.bind(window);
  const realClearInterval = window.clearInterval.bind(window);
  const timers = new Map();
  const timerDelays = new Map();
  let nextTimer = 1000;
  window.setInterval = (callback, delay, ...args) => {
    if (delay !== 300_000) return realSetInterval(callback, delay, ...args);
    const id = ++nextTimer;
    timers.set(id, () => callback(...args));
    timerDelays.set(id, delay);
    return id;
  };
  window.clearInterval = (id) => {
    if (timers.has(id)) { timers.delete(id); timerDelays.delete(id); }
    else realClearInterval(id);
  };

  window.monitoringTest = {
    state,
    holdNext(kind) { heldKinds.push(kind); },
    pending() { return Array.from(pending.values(), (entry) => entry.request); },
    finish(id, errorMessage = "") {
      const entry = pending.get(id);
      if (!entry) throw new Error(`No pending request ${id}`);
      pending.delete(id);
      entry.resolve(errorMessage ? { data: null, error: { message: errorMessage } } : entry.snapshot);
    },
    tick() { Array.from(timers.values()).forEach((callback) => callback()); },
    timerCount() { return timers.size; },
    timerDelays() { return Array.from(timerDelays.values()); },
    setHidden(hidden) {
      Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
      document.dispatchEvent(new Event("visibilitychange"));
    },
  };
  window.GOOGLE_MONITORING_CONFIG = {
    supabaseUrl: "https://example.invalid",
    supabasePublishableKey: "sb_publishable_test",
  };
  window.supabase = { createClient: () => client };
})();
