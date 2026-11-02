(() => {
  "use strict";

  const PAGE_SIZE = 50;
  const config = window.GOOGLE_MONITORING_CONFIG || {};
  const loginView = document.getElementById("login-view");
  const appView = document.getElementById("app-view");
  const globalError = document.getElementById("global-error");
  let client = null;
  let workers = [];
  let activeWorker = "";
  let activeView = "overview";
  let placesOffset = 0;
  let placesTotal = 0;
  let logsOffset = 0;
  let logsTotal = 0;
  let detailPlace = null;
  let attemptsOffset = 0;
  let attemptsTotal = 0;
  let pollTimer = null;

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

  function formatCount(value) {
    return Number(value || 0).toLocaleString();
  }

  function setError(message = "") {
    globalError.textContent = message;
  }

  function resultOrThrow(result) {
    if (result.error) throw result.error;
    return result.data;
  }

  function makeTable(headers, rows) {
    const wrapper = el("div", "table-wrap");
    const table = el("table");
    const thead = el("thead");
    const headRow = el("tr");
    headers.forEach((header) => headRow.append(el("th", "", header)));
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
    wrapper.append(table);
    if (!rows.length) wrapper.append(el("p", "empty", "No records found."));
    return wrapper;
  }

  function setPager(prefix, offset, total, onPrevious, onNext) {
    const page = Math.floor(offset / PAGE_SIZE) + 1;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    document.getElementById(`${prefix}-page`).textContent = `Page ${page} of ${pages} · ${formatCount(total)} rows`;
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

  function populateWorkers() {
    const active = document.getElementById("active-worker");
    const logWorker = document.getElementById("log-worker");
    active.replaceChildren();
    logWorker.replaceChildren();
    const all = el("option", "", "All workers");
    all.value = "";
    active.append(all);
    const logAll = el("option", "", "All workers");
    logAll.value = "";
    logWorker.append(logAll);
    workers.forEach((worker) => {
      const label = `${workerLabel(worker)} · ${worker.worker_id.slice(0, 8)}`;
      const option = el("option", "", label);
      option.value = worker.worker_id;
      active.append(option);
      const logOption = el("option", "", label);
      logOption.value = worker.worker_id;
      logWorker.append(logOption);
    });
    active.value = activeWorker;
    logWorker.value = activeWorker;
  }

  function metricCard(label, value, subvalue) {
    const card = el("div", "card");
    card.append(el("div", "label", label), el("div", "value", value));
    if (subvalue) card.append(el("span", "subvalue", subvalue));
    return card;
  }

  async function renderOverview() {
    const container = document.getElementById("overview-view");
    container.replaceChildren();
    const data = resultOrThrow(await client.rpc("monitoring_overview", {
      p_worker_id: activeWorker || null,
    }));
    const chosenWorkers = activeWorker ? workers.filter((worker) => worker.worker_id === activeWorker) : workers;
    if (!chosenWorkers.length) {
      container.append(el("p", "empty", "No scraper worker is provisioned yet."));
      return;
    }
    const counts = data.queue_counts || {};
    const outcomes = data.outcome_counts || {};
    const summary = el("div", "cards");
    const pending = Number(counts.pending || 0) + Number(counts.retry_wait || 0);
    const queueTotal = Object.values(counts).reduce((sum, count) => sum + Number(count || 0), 0);
    summary.append(
      metricCard("Places in queue", formatCount(queueTotal), `${formatCount(pending)} pending or waiting to retry`),
      metricCard("Completed outcomes", formatCount(Number(outcomes.found || 0) + Number(outcomes.found_no_phone || 0)),
        `${formatCount(outcomes.not_found || 0)} not found · ${formatCount(outcomes.ambiguous || 0)} ambiguous`),
    );
    container.append(summary);

    chosenWorkers.forEach((worker) => {
      const state = worker.current_state || {};
      const heartbeatAt = worker.last_heartbeat_at;
      const heartbeatAge = heartbeatAt ? Date.now() - new Date(heartbeatAt).getTime() : Infinity;
      const reporting = Number.isFinite(heartbeatAge) && heartbeatAge < 180_000;
      const runStatus = reporting ? "Heartbeat recent" : "Worker not reporting";
      const runBadge = el("span", `badge${reporting ? "" : " warning"}`, runStatus);
      const section = el("section", "panel");
      const header = el("div", "worker-head");
      header.append(el("h2", "", workerLabel(worker)), runBadge);
      section.append(header);
      section.append(el("p", "muted", `Worker ID ${worker.worker_id}`));

      const usage = `${formatCount(state.daily_usage)} / ${formatCount(state.daily_limit)}`;
      const day = state.bangkok_day ? `Bangkok day ${state.bangkok_day}` : "No heartbeat usage reported yet";
      const current = state.current_job ? `${state.current_job.osm_id || ""} · ${state.current_job.name || ""}` : "Idle or not currently looking up a place";
      const exit = worker.last_exit ? `${worker.last_exit.outcome || "exit reported"}${worker.last_exit.reason ? ` · ${worker.last_exit.reason}` : ""}` : "No run exit reported yet";
      const queue = state.queue_counts || {};
      const queueLine = Object.entries(queue).map(([name, count]) => `${name}: ${formatCount(count)}`).join(" · ") || "No queue counts reported yet";
      const cards = el("div", "cards");
      cards.append(
        metricCard("Daily usage / limit", usage, day),
        metricCard(reporting ? "Current lookup" : "Last reported lookup", current, `Pending uploads: ${formatCount(state.pending_upload_count)}`),
        metricCard("Last heartbeat", formatDate(worker.last_heartbeat_at), reporting ? "Received within three minutes" : "No heartbeat received within three minutes"),
        metricCard("Last upload", formatDate(worker.last_upload_at), `Last seen ${formatDate(worker.last_seen_at)}`),
      );
      section.append(cards);
      const detail = el("div", "muted", `Queue: ${queueLine} · Last reported exit: ${exit}`);
      if (state.pause_reason) detail.append(el("span", "badge error", `Paused: ${state.pause_reason}`));
      section.append(detail);
      container.append(section);
    });
  }

  function selectedReview() {
    const value = document.getElementById("place-review").value;
    return value === "" ? null : value === "true";
  }

  async function renderPlaces() {
    const query = document.getElementById("place-query").value.trim();
    const outcome = document.getElementById("place-outcome").value;
    const queueStatus = document.getElementById("place-status").value;
    const data = resultOrThrow(await client.rpc("monitoring_places_page", {
      p_query: query,
      p_outcome: outcome,
      p_queue_status: queueStatus,
      p_worker_id: activeWorker || null,
      p_review_flag: selectedReview(),
      p_limit: PAGE_SIZE,
      p_offset: placesOffset,
    }));
    placesTotal = Number(data.total || 0);
    const rows = (data.rows || []).map((place) => {
      const name = place.source_record?.name || "(unnamed)";
      const button = el("button", "link", name);
      button.type = "button";
      button.addEventListener("click", () => openDetail(place).catch((error) => setError(error?.message || "Unable to load place details.")));
      return [button, place.worker_id.slice(0, 8), place.osm_id, place.outcome || "—", place.queue_status || "—", place.review_flag ? "Yes" : "No", place.latest_error_code || "—"];
    });
    document.getElementById("places-table").replaceChildren(makeTable(
      ["Name", "Worker", "OSM ID", "Outcome", "Queue", "Review", "Latest error"], rows,
    ));
    setPager("places", placesOffset, placesTotal,
      () => { placesOffset = Math.max(0, placesOffset - PAGE_SIZE); refreshCurrent(); },
      () => { placesOffset += PAGE_SIZE; refreshCurrent(); });
  }

  async function openDetail(place) {
    detailPlace = place;
    attemptsOffset = 0;
    document.getElementById("detail-title").textContent = `${place.source_record?.name || "Place"} · ${place.osm_id}`;
    await renderDetail();
    document.getElementById("place-dialog").showModal();
  }

  function detailPanel(title, value) {
    const column = el("div", "detail-column");
    column.append(el("h3", "", title));
    const pre = el("pre");
    pre.textContent = JSON.stringify(value ?? {}, null, 2);
    column.append(pre);
    return column;
  }

  async function renderDetail() {
    if (!detailPlace) return;
    const content = document.getElementById("detail-content");
    content.replaceChildren();
    const columns = el("div", "detail-columns");
    columns.append(
      detailPanel("OSM source fields", detailPlace.source_record),
      detailPanel("Latest successful Google proposal", detailPlace.google_proposal),
    );
    content.append(columns);
    content.append(detailPanel("Latest candidates", detailPlace.candidates));
    content.append(el("p", "muted", `Matching: ${detailPlace.matching_method || "—"} · Similarity: ${detailPlace.similarity ?? "—"} · Distance: ${detailPlace.distance_m ?? "—"} m · Review flag: ${detailPlace.review_flag ? "Yes" : "No"}`));
    if (detailPlace.latest_error_code || detailPlace.latest_error_message) {
      const error = el("div", "panel");
      error.append(el("strong", "", `Latest error ${detailPlace.latest_error_code || ""}`));
      error.append(el("p", "", detailPlace.latest_error_message || ""));
      content.append(error);
    }
    const result = await client.from("monitoring_attempts")
      .select("attempt_id,run_id,status,outcome,candidates,proposal,matching_method,similarity,distance_m,review_flag,errors,error_code,error_message,worker_started_at,worker_completed_at,received_at", { count: "exact" })
      .eq("worker_id", detailPlace.worker_id)
      .eq("osm_id", detailPlace.osm_id)
      .order("worker_completed_at", { ascending: false })
      .order("attempt_id", { ascending: false })
      .range(attemptsOffset, attemptsOffset + PAGE_SIZE - 1);
    const attempts = resultOrThrow(result) || [];
    attemptsTotal = Number(result.count || 0);
    const rows = attempts.map((attempt) => [
      formatDate(attempt.worker_completed_at), attempt.status, attempt.outcome || "—",
      attempt.matching_method || "—", attempt.error_code || attempt.error_message || "—",
      { node: makeDisclosure(attempt), className: "wrap" },
    ]);
    document.getElementById("attempts-table").replaceChildren(makeTable(
      ["Completed", "Status", "Outcome", "Match", "Latest error", "Evidence"], rows,
    ));
    setPager("attempts", attemptsOffset, attemptsTotal,
      () => { attemptsOffset = Math.max(0, attemptsOffset - PAGE_SIZE); renderDetail(); },
      () => { attemptsOffset += PAGE_SIZE; renderDetail(); });
  }

  function makeDisclosure(attempt) {
    const details = el("details");
    details.append(el("summary", "", "View"));
    const pre = el("pre");
    pre.textContent = JSON.stringify({
      started_at: attempt.worker_started_at,
      completed_at: attempt.worker_completed_at,
      candidates: attempt.candidates,
      proposal: attempt.proposal,
      errors: attempt.errors,
    }, null, 2);
    details.append(pre);
    return details;
  }

  async function renderLogs() {
    let query = client.from("monitoring_operational_events")
      .select("event_id,worker_id,run_id,attempt_id,worker_sequence,event_type,severity,data,worker_occurred_at,received_at", { count: "exact" })
      .order("received_at", { ascending: false })
      .order("event_id", { ascending: false })
      .range(logsOffset, logsOffset + PAGE_SIZE - 1);
    const workerId = document.getElementById("log-worker").value;
    const severity = document.getElementById("log-severity").value;
    const from = document.getElementById("log-from").value;
    const to = document.getElementById("log-to").value;
    if (workerId) query = query.eq("worker_id", workerId);
    if (severity) query = query.eq("severity", severity);
    if (from) query = query.gte("received_at", new Date(from).toISOString());
    if (to) query = query.lte("received_at", new Date(to).toISOString());
    const result = await query;
    const events = resultOrThrow(result) || [];
    logsTotal = Number(result.count || 0);
    const rows = events.map((event) => [
      formatDate(event.received_at), event.severity, event.event_type,
      event.worker_id.slice(0, 8), event.run_id || "—",
      { node: jsonDisclosure(event.data), className: "wrap" },
    ]);
    document.getElementById("logs-table").replaceChildren(makeTable(
      ["Received", "Severity", "Event", "Worker", "Run", "Details"], rows,
    ));
    setPager("logs", logsOffset, logsTotal,
      () => { logsOffset = Math.max(0, logsOffset - PAGE_SIZE); refreshCurrent(); },
      () => { logsOffset += PAGE_SIZE; refreshCurrent(); });
  }

  function jsonDisclosure(value) {
    const details = el("details");
    details.append(el("summary", "", "View"));
    const pre = el("pre");
    pre.textContent = JSON.stringify(value ?? {}, null, 2);
    details.append(pre);
    return details;
  }

  async function refreshCurrent() {
    if (document.hidden || !client || appView.hidden) return;
    setError("");
    try {
      if (activeView === "overview") await renderOverview();
      else if (activeView === "places") {
        await renderPlaces();
        if (detailPlace && document.getElementById("place-dialog").open) {
          const latest = await client.from("monitoring_place_results").select("*")
            .eq("worker_id", detailPlace.worker_id).eq("osm_id", detailPlace.osm_id).maybeSingle();
          detailPlace = resultOrThrow(latest) || detailPlace;
          await renderDetail();
        }
      }
      else await renderLogs();
    } catch (error) {
      setError(error?.message || "Unable to load monitoring data.");
    }
  }

  async function refreshWorkers() {
    const result = await client.from("monitoring_workers")
      .select("worker_id,display_name,created_at,last_seen_at,last_upload_at,last_heartbeat_at,current_state,last_exit,last_event_sequence")
      .order("display_name");
    workers = resultOrThrow(result) || [];
    if (activeWorker && !workers.some((worker) => worker.worker_id === activeWorker)) activeWorker = "";
    populateWorkers();
  }

  function showApp(user) {
    loginView.hidden = true;
    appView.hidden = false;
    document.getElementById("account-email").textContent = user?.email || "Signed in";
    refreshWorkers().then(refreshCurrent).catch((error) => setError(error?.message || "Unable to load workers."));
    startPolling();
  }

  function showLogin() {
    appView.hidden = true;
    loginView.hidden = false;
    stopPolling();
  }

  function startPolling() {
    stopPolling();
    if (!document.hidden) pollTimer = window.setInterval(() => {
      refreshWorkers().then(refreshCurrent).catch((error) => setError(error?.message || "Unable to refresh data."));
    }, 30_000);
  }

  function stopPolling() {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = null;
  }

  function switchView(view) {
    activeView = view;
    document.querySelectorAll(".tab").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
    document.querySelectorAll(".view").forEach((section) => { section.hidden = section.id !== `${view}-view`; });
    refreshCurrent();
  }

  document.getElementById("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorNode = document.getElementById("login-error");
    errorNode.textContent = "";
    const submit = event.currentTarget.querySelector("button[type=submit]");
    submit.disabled = true;
    try {
      const result = await client.auth.signInWithPassword({
        email: document.getElementById("email").value,
        password: document.getElementById("password").value,
      });
      if (result.error) throw result.error;
      showApp(result.data.user);
    } catch (error) {
      errorNode.textContent = error?.message || "Sign-in failed.";
    } finally {
      submit.disabled = false;
    }
  });

  document.getElementById("sign-out").addEventListener("click", async () => {
    await client.auth.signOut();
    showLogin();
  });
  document.getElementById("active-worker").addEventListener("change", (event) => {
    activeWorker = event.target.value;
    document.getElementById("log-worker").value = activeWorker;
    placesOffset = 0;
    logsOffset = 0;
    refreshCurrent();
  });
  document.getElementById("log-worker").addEventListener("change", (event) => {
    activeWorker = event.target.value;
    document.getElementById("active-worker").value = activeWorker;
    logsOffset = 0;
    refreshCurrent();
  });
  document.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  document.getElementById("place-search").addEventListener("click", () => { placesOffset = 0; refreshCurrent(); });
  document.getElementById("place-query").addEventListener("keydown", (event) => {
    if (event.key === "Enter") { placesOffset = 0; refreshCurrent(); }
  });
  document.getElementById("place-dialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  document.getElementById("detail-close").addEventListener("click", () => document.getElementById("place-dialog").close());
  document.getElementById("log-search").addEventListener("click", () => { logsOffset = 0; refreshCurrent(); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopPolling();
    else if (!appView.hidden) {
      refreshWorkers().then(refreshCurrent).catch((error) => setError(error?.message || "Unable to refresh data."));
      startPolling();
    }
  });

  if (!window.supabase?.createClient) {
    document.getElementById("login-error").textContent = "Supabase browser library did not load.";
    return;
  }
  if (!config.supabaseUrl || !config.supabasePublishableKey) {
    document.getElementById("login-error").textContent = "Copy config.example.js to config.js and add the Supabase URL and publishable key.";
    return;
  }
  client = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  client.auth.getSession().then(({ data, error }) => {
    if (error) setError(error.message);
    if (data?.session?.user) showApp(data.session.user);
  });
  client.auth.onAuthStateChange((_event, session) => {
    if (session?.user) showApp(session.user);
    else showLogin();
  });
})();
