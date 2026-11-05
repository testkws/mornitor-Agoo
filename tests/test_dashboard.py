import re
from pathlib import Path

import pytest
from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
HTML = re.sub(
    r"<script\b[^>]*>.*?</script>|<link\b[^>]*>",
    "",
    (ROOT / "index.html").read_text(),
    flags=re.IGNORECASE | re.DOTALL,
)
APP = (ROOT / "app.js").read_text()
MOCK = (ROOT / "tests" / "mock_supabase.js").read_text()
STYLES = (ROOT / "styles.css").read_text()


@pytest.fixture(scope="session")
def browser():
    with sync_playwright() as playwright:
        instance = playwright.chromium.launch(headless=True)
        yield instance
        instance.close()


@pytest.fixture
def page(browser):
    instance = browser.new_page()
    instance.route("**/*", lambda route: route.abort())
    instance.set_content(HTML)
    instance.add_style_tag(content=STYLES)
    instance.add_script_tag(content=MOCK)
    instance.add_script_tag(content=APP)
    expect(instance.locator("#live-text")).to_contain_text("Updated")
    yield instance
    instance.close()


def show(page, view):
    page.locator(f'button[data-view="{view}"]').click()


def hold(page, kind):
    page.evaluate("kind => window.monitoringTest.holdNext(kind)", kind)


def pending(page, kind):
    page.wait_for_function(
        "kind => window.monitoringTest.pending().some(request => request.kind === kind)",
        arg=kind,
    )
    return page.evaluate(
        "kind => window.monitoringTest.pending().find(request => request.kind === kind).id",
        kind,
    )


def finish(page, request_id, message=""):
    page.evaluate(
        "({id, message}) => window.monitoringTest.finish(id, message)",
        {"id": request_id, "message": message},
    )
    page.evaluate("() => new Promise(resolve => setTimeout(resolve, 0))")


def request_offsets(page, kind):
    return page.evaluate(
        "kind => window.monitoringTest.state.requests.filter(request => request.kind === kind)"
        ".map(request => request.params.p_offset ?? request.params.offset)",
        kind,
    )


def seed_place_times(page):
    page.evaluate("""() => {
      const state = window.monitoringTest.state;
      const id = number => '00000000-0000-4000-8000-' + String(number).padStart(12, '0');
      const place = (worker, osm, name, attempt) => ({
        worker_id: worker, osm_id: osm, source_record: {name}, latest_attempt_id: id(attempt),
        outcome: 'found', queue_status: 'checked', review_flag: false,
      });
      state.places = [
        place(state.workerA, 'node/1', 'Quick place', 1),
        place(state.workerA, 'node/2', 'Slow place', 2),
        place(state.workerB, 'node/3', 'Other worker place', 1),
        place(state.workerA, 'node/4', 'Missing start', 3),
        place(state.workerA, 'node/5', 'Pending place', 4),
        place(state.workerA, 'node/6', 'Mismatched place', 5),
        place(state.workerA, 'node/7', 'Zero place', 6),
      ];
      const start = '2026-11-03T00:00:00.000Z';
      const attempt = (worker, osm, number, started, completed) => ({
        worker_id: worker, osm_id: osm, attempt_id: id(number), status: 'checked',
        outcome: 'found', worker_started_at: started, worker_completed_at: completed,
      });
      state.attempts = [
        attempt(state.workerA, 'node/1', 1, start, '2026-11-03T00:00:02.000Z'),
        attempt(state.workerA, 'node/2', 2, start, '2026-11-03T00:00:10.000Z'),
        attempt(state.workerB, 'node/3', 1, start, '2026-11-03T00:00:05.000Z'),
        attempt(state.workerA, 'node/4', 3, null, '2026-11-03T00:00:03.000Z'),
        attempt(state.workerA, 'node/other', 5, start, '2026-11-03T00:00:04.000Z'),
        attempt(state.workerA, 'node/7', 6, start, start),
      ];
    }""")


def metric(page, name):
    return page.locator(f'[data-metric="{name}"]')


def seed_summary_data(page):
    page.evaluate("""() => {
      const state = window.monitoringTest.state;
      const now = Date.UTC(2026, 10, 3, 12, 0, 0);
      Date.now = () => now;
      const row = (worker_id, offset, outcome, status, error_code = null) => ({
        worker_id, outcome, status, error_code, osm_id: 'node/test',
        attempt_id: String(offset) + worker_id, worker_completed_at: new Date(now + offset).toISOString()
      });
      state.attempts = [
        row(state.workerA, -1000, 'found', 'checked'),
        row(state.workerA, -2000, 'found_no_phone', 'retry_wait'),
        row(state.workerA, -3000, 'not_found', 'retry_wait'),
        row(state.workerA, -4000, 'ambiguous', 'retry_wait'),
        row(state.workerA, -5000, 'lookup_error', 'retry_wait', 'TIMEOUT'),
        row(state.workerA, -6000, 'lookup_error', 'blocked', 'BLOCKED'),
        row(state.workerA, -7000, 'lookup_error', 'blocked', 'CONSENT_REQUIRED'),
        row(state.workerA, -86400000, 'found', 'checked'),
        row(state.workerA, -86400001, 'found', 'checked'),
        row(state.workerA, 1000, 'found', 'checked'),
        row(state.workerB, -1000, 'found', 'checked')
      ];
      state.workers[0].last_heartbeat_at = new Date(now - 60000).toISOString();
      state.workers[1].last_heartbeat_at = new Date(now - 700000).toISOString();
    }""")


def test_summary_metrics_use_attempts_in_window_and_selected_worker(page):
    seed_summary_data(page)
    page.locator("#refresh").click()
    expect(metric(page, "success").locator(".summary-value")).to_have_text("44.4%")
    expect(metric(page, "success")).to_contain_text("4 of 9 attempts")
    expect(metric(page, "retry").locator(".summary-value")).to_have_text("11.1%")
    expect(metric(page, "blocked").locator(".summary-value")).to_have_text("1")
    expect(metric(page, "blocked")).to_contain_text("1 consent required")
    expect(metric(page, "queue").locator(".summary-value")).to_have_text("30")
    expect(metric(page, "queue")).to_contain_text("20 pending · 10 scheduled")
    expect(metric(page, "queue")).to_contain_text("2 running · includes future rechecks")
    expect(metric(page, "workers").locator(".summary-value")).to_have_text("1 / 2")
    expect(page.get_by_text("Last reported paused: BLOCKED")).to_be_visible()
    expect(page.get_by_text("Worker not reporting")).to_be_visible()
    attempts_chart = page.get_by_role("region", name="Attempt results")
    queue_chart = page.get_by_role("region", name="Queue snapshot")
    expect(attempts_chart.locator('[data-result="matched"]')).to_contain_text("4 · 44.4%")
    expect(attempts_chart.locator('[data-result="other"]')).to_contain_text("5 · 55.6%")
    share = attempts_chart.locator(".chart-donut").evaluate("node => parseFloat(node.style.getPropertyValue('--matched-share'))")
    assert share == pytest.approx(4 * 100 / 9)
    for status, count, width in (("pending", "20", "100%"), ("scheduled", "10", "50%"), ("running", "2", "10%")):
        row = queue_chart.locator(f'[data-status="{status}"]')
        expect(row.locator("strong")).to_have_text(count)
        assert row.locator(".chart-bar-fill").evaluate("node => node.style.width") == width

    page.locator("#active-worker").select_option(page.evaluate("window.monitoringTest.state.workerA"))
    expect(metric(page, "success").locator(".summary-value")).to_have_text("37.5%")
    expect(metric(page, "retry").locator(".summary-value")).to_have_text("12.5%")
    expect(metric(page, "success")).to_contain_text("3 of 8 attempts")
    expect(attempts_chart.locator('[data-result="matched"]')).to_contain_text("3 · 37.5%")
    expect(attempts_chart.locator('[data-result="other"]')).to_contain_text("5 · 62.5%")
    page.locator("#active-worker").select_option(page.evaluate("window.monitoringTest.state.workerB"))
    expect(metric(page, "success").locator(".summary-value")).to_have_text("100.0%")
    expect(metric(page, "retry").locator(".summary-value")).to_have_text("0.0%")
    expect(metric(page, "blocked").locator(".summary-value")).to_have_text("0")
    expect(metric(page, "queue").locator(".summary-value")).to_have_text("0")
    expect(attempts_chart.locator('[data-result="matched"]')).to_contain_text("1 · 100.0%")
    expect(attempts_chart.locator('[data-result="other"]')).to_contain_text("0 · 0.0%")
    for row in queue_chart.locator(".chart-bar-item").all():
        expect(row.locator("strong")).to_have_text("0")
        assert row.locator(".chart-bar-fill").evaluate("node => node.style.width") == "0%"


def test_empty_summary_and_no_workers(page):
    page.evaluate("""() => {
      const state = window.monitoringTest.state;
      state.attempts = []; state.workers = []; state.places = [];
    }""")
    page.locator("#refresh").click()
    expect(metric(page, "success").locator(".summary-value")).to_have_text("—")
    expect(metric(page, "retry")).to_contain_text("No completed attempts")
    expect(metric(page, "blocked").locator(".summary-value")).to_have_text("0")
    expect(metric(page, "queue").locator(".summary-value")).to_have_text("0")
    expect(metric(page, "workers")).to_contain_text("No workers provisioned")
    expect(page.get_by_text("No scraper worker is provisioned yet.")).to_be_visible()
    expect(page.get_by_role("region", name="Attempt results")).to_contain_text("No completed attempts in the last 24 hours.")


def test_resume_state_does_not_present_historical_pause_as_current(page):
    page.evaluate("""() => {
      const worker = window.monitoringTest.state.workers[1];
      worker.current_state = {state_event_type: 'queue_resumed', pause_reason: null,
        daily_usage: 7, bangkok_day: '2026-11-03', safety_sequence: 15,
        safety: {recent_attempts: 0, recent_temporary_errors: 0, consecutive_temporary_errors: 0}};
      worker.last_exit = {outcome: 'paused', reason: 'BLOCKED', safety_sequence: 12,
        safety: {recent_attempts: 3, recent_temporary_errors: 3, consecutive_temporary_errors: 3}};
    }""")
    page.locator("#refresh").click()
    expect(page.get_by_text("Queue resumed", exact=True)).to_be_visible()
    expect(page.get_by_text("Last run ended paused: BLOCKED", exact=True)).to_have_count(0)
    expect(page.get_by_text("Last reported exit: paused · BLOCKED", exact=True)).to_be_visible()
    expect(metric(page, "workers")).to_contain_text("0 last reported paused")
    panel = page.locator(".worker-panel").filter(has_text="Worker B")
    expect(panel).to_contain_text("7 / —")
    expect(panel).to_contain_text("Temporary errors: 0 / 0 recent attempts · 0 consecutive")
    expect(page.get_by_text("Worker not reporting")).to_be_visible()


def test_exit_snapshot_displays_stopped_runner_and_latest_usage(page):
    page.evaluate("""() => {
      const worker = window.monitoringTest.state.workers[0];
      worker.current_state = {state_event_type: 'run_ended', runner_alive: false, pause_reason: null,
        daily_usage: 8, daily_limit: 500, bangkok_day: '2026-11-03',
        safety_sequence: 10, safety: {recent_attempts: 1, recent_temporary_errors: 0, consecutive_temporary_errors: 0}};
      worker.last_exit = {outcome: 'no_due_work', reason: 'No lookup is currently due', safety_sequence: 10};
    }""")
    page.locator("#refresh").click()
    panel = page.locator(".worker-panel").filter(has_text="Worker A")
    expect(panel).to_contain_text("Runner stopped")
    expect(panel).to_contain_text("8 / 500")
    expect(panel).to_contain_text("Last reported exit: no_due_work · No lookup is currently due")


def test_safety_counts_use_latest_run_exit_or_heartbeat_sequence(page):
    page.evaluate("""() => {
      const worker = window.monitoringTest.state.workers[0];
      worker.current_state.safety_sequence = 10;
      worker.current_state.safety = {recent_attempts: 2, recent_temporary_errors: 2, consecutive_temporary_errors: 2};
      worker.last_exit = {outcome: 'paused', reason: 'TEMPORARY_ERRORS', safety_sequence: 12,
        safety: {recent_attempts: 3, recent_temporary_errors: 3, consecutive_temporary_errors: 3}};
    }""")
    page.locator("#refresh").click()
    panel = page.locator(".worker-panel").filter(has_text="Worker A")
    expect(panel).to_contain_text("Temporary errors: 3 / 3 recent attempts · 3 consecutive")
    expect(panel).to_contain_text("Last reported exit: paused · TEMPORARY_ERRORS")

    page.evaluate("""() => {
      const state = window.monitoringTest.state.workers[0].current_state;
      state.safety_sequence = 15;
      state.safety = {recent_attempts: 1, recent_temporary_errors: 0, consecutive_temporary_errors: 0};
    }""")
    page.locator("#refresh").click()
    expect(panel).to_contain_text("Temporary errors: 0 / 1 recent attempts · 0 consecutive")


def test_missing_and_future_heartbeats_are_not_counted_as_recent(page):
    page.evaluate("""() => {
      const workers = window.monitoringTest.state.workers;
      workers[0].last_heartbeat_at = null;
      workers[1].last_heartbeat_at = new Date(Date.now() + 600000).toISOString();
    }""")
    page.locator("#refresh").click()
    expect(metric(page, "workers").locator(".summary-value")).to_have_text("0 / 2")
    expect(page.get_by_text("Worker not reporting")).to_have_count(2)


def test_failed_metric_does_not_hide_queue_and_worker_status(page):
    hold(page, "metric-matched")
    page.locator("#refresh").click()
    finish(page, pending(page, "metric-matched"), "Metrics unavailable")
    expect(metric(page, "success").locator(".summary-value")).to_have_text("—")
    expect(metric(page, "retry").locator(".summary-value")).to_have_text("0.0%")
    expect(metric(page, "queue").locator(".summary-value")).to_have_text("30")
    expect(metric(page, "workers").locator(".summary-value")).to_have_text("1 / 2")
    expect(page.locator("#global-error")).to_contain_text("Some performance metrics are unavailable")
    expect(page.locator("#live-text")).to_have_text("Partial update")
    expect(page.get_by_role("region", name="Attempt results")).to_contain_text("Attempt counts are unavailable")
    expect(page.get_by_role("region", name="Queue snapshot").locator('[data-status="pending"] strong')).to_have_text("20")
    page.locator("#refresh").click()
    expect(metric(page, "success").locator(".summary-value")).to_have_text("100.0%")
    expect(page.get_by_role("region", name="Attempt results").locator('[data-result="matched"]')).to_contain_text("101 · 100.0%")
    expect(page.locator("#global-error")).to_be_empty()


@pytest.mark.parametrize("failed_kind", ["metric-total", "metric-consent", "metric-blocked", "metric-retry"])
def test_individual_metric_failure_is_not_reported_as_zero(page, failed_kind):
    seed_summary_data(page)
    hold(page, failed_kind)
    page.locator("#refresh").click()
    finish(page, pending(page, failed_kind), "Count unavailable")
    expect(page.locator("#global-error")).to_contain_text("Some performance metrics are unavailable")
    expect(metric(page, "queue").locator(".summary-value")).to_have_text("30")
    if failed_kind == "metric-total":
        expect(metric(page, "success").locator(".summary-value")).to_have_text("—")
        expect(metric(page, "retry").locator(".summary-value")).to_have_text("—")
        expect(metric(page, "blocked").locator(".summary-value")).to_have_text("1")
        expect(page.get_by_role("region", name="Attempt results")).to_contain_text("Attempt counts are unavailable")
    elif failed_kind == "metric-consent":
        expect(metric(page, "blocked")).to_contain_text("Consent count unavailable")
        expect(metric(page, "blocked").locator(".summary-value")).to_have_text("1")
    elif failed_kind == "metric-blocked":
        expect(metric(page, "blocked").locator(".summary-value")).to_have_text("—")
        expect(metric(page, "blocked")).to_contain_text("1 consent required")
    else:
        expect(metric(page, "retry").locator(".summary-value")).to_have_text("—")
        expect(metric(page, "success").locator(".summary-value")).to_have_text("44.4%")


def test_inconsistent_counts_do_not_show_impossible_rates(page):
    hold(page, "metric-matched")
    page.locator("#refresh").click()
    request_id = pending(page, "metric-matched")
    page.evaluate("window.monitoringTest.state.attempts = []")
    finish(page, request_id)
    expect(metric(page, "success").locator(".summary-value")).to_have_text("—")
    expect(page.locator("#global-error")).to_contain_text("Some performance metrics are unavailable")
    expect(page.get_by_role("region", name="Attempt results")).to_contain_text("Attempt counts are unavailable")


def test_old_overview_metrics_cannot_replace_new_worker_selection(page):
    hold(page, "metric-matched")
    page.locator("#refresh").click()
    old_request = pending(page, "metric-matched")
    page.locator("#active-worker").select_option(page.evaluate("window.monitoringTest.state.workerB"))
    expect(metric(page, "success")).to_contain_text("No completed attempts")
    expect(metric(page, "workers").locator(".summary-value")).to_have_text("0 / 1")
    finish(page, old_request)
    expect(metric(page, "success")).to_contain_text("No completed attempts")
    expect(metric(page, "workers").locator(".summary-value")).to_have_text("0 / 1")
    expect(page.get_by_role("region", name="Attempt results")).to_contain_text("No completed attempts")
    expect(page.locator("#global-error")).to_be_empty()


def test_summary_uses_head_counts_without_page_limit(page):
    initial_queries = page.evaluate("window.monitoringTest.state.requests.filter(r => r.kind.startsWith('metric-')).length")
    page.evaluate("""() => {
      const state = window.monitoringTest.state;
      state.attempts = Array.from({length: 1250}, (_, index) => ({
        worker_id: state.workerA, attempt_id: String(index), outcome: 'found', status: 'checked',
        worker_completed_at: new Date(Date.now() - 1000).toISOString()
      }));
    }""")
    page.locator("#refresh").click()
    expect(metric(page, "success")).to_contain_text("1,250 of 1,250 attempts")
    requests = page.evaluate("start => window.monitoringTest.state.requests.filter(r => r.kind.startsWith('metric-')).slice(start)", initial_queries)
    assert len(requests) == 5
    assert all(request["params"]["head"] for request in requests)
    assert requests[-1]["kind"] == "metric-total"


@pytest.mark.parametrize("width", [320, 360, 375, 768, 1024, 1440])
def test_responsive_layout_and_theme(page, width):
    page.set_viewport_size({"width": width, "height": 900})
    for view in ("overview", "places", "logs"):
        show(page, view)
        expect(page.locator(f"#{view}-view")).to_be_visible()
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), view
    page.locator("#theme-toggle").click()
    assert page.evaluate("document.documentElement.dataset.theme") == "dark"
    show(page, "overview")
    expect(metric(page, "success")).to_be_visible()
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")


@pytest.mark.parametrize("width", [320, 480, 481, 768, 900, 1024, 1440])
def test_header_controls_are_aligned(page, width):
    page.set_viewport_size({"width": width, "height": 900})
    select = page.locator("#active-worker").bounding_box()
    refresh = page.locator("#refresh").bounding_box()
    theme = page.locator("#theme-toggle").bounding_box()
    status = page.locator("#live-status").bounding_box()
    assert select and refresh and theme and status
    for button in (refresh, theme):
        assert abs(button["y"] - select["y"]) <= 1
        assert abs(button["height"] - select["height"]) <= 1
        assert button["width"] >= 44 and button["height"] >= 44
    assert select["x"] + select["width"] <= refresh["x"]
    assert refresh["x"] + refresh["width"] <= theme["x"]
    assert theme["x"] + theme["width"] <= width
    if width > 480:
        assert abs((status["y"] + status["height"] / 2) - (select["y"] + select["height"] / 2)) <= 1
        assert status["x"] + status["width"] <= select["x"]
    else:
        assert status["y"] + status["height"] < select["y"]
    expect(page.get_by_role("combobox", name="Worker", exact=True)).to_have_attribute("id", "active-worker")


@pytest.mark.parametrize("width", [481, 768])
def test_header_remains_usable_with_enlarged_text(page, width):
    page.set_viewport_size({"width": width, "height": 900})
    page.evaluate("document.documentElement.style.fontSize = '200%'")
    select = page.locator("#active-worker").bounding_box()
    refresh = page.locator("#refresh").bounding_box()
    theme = page.locator("#theme-toggle").bounding_box()
    assert select and refresh and theme
    assert abs(refresh["y"] - select["y"]) <= 1
    assert abs(theme["y"] - select["y"]) <= 1
    assert theme["x"] + theme["width"] <= width
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")


def test_theme_control_tracks_system_and_manual_preference(page):
    toggle = page.locator("#theme-toggle")
    page.emulate_media(color_scheme="light")
    expect(toggle).to_have_attribute("aria-label", "Switch to dark theme")
    expect(page.locator("#theme-icon-moon")).to_be_visible()
    expect(page.locator("#theme-icon-sun")).to_be_hidden()

    page.emulate_media(color_scheme="dark")
    expect(toggle).to_have_attribute("aria-label", "Switch to light theme")
    expect(page.locator("#theme-icon-sun")).to_be_visible()
    expect(page.locator("#theme-icon-moon")).to_be_hidden()

    toggle.click()
    expect(toggle).to_have_attribute("aria-label", "Switch to dark theme")
    assert page.evaluate("document.documentElement.dataset.theme") == "light"
    page.emulate_media(color_scheme="light")
    page.emulate_media(color_scheme="dark")
    expect(toggle).to_have_attribute("aria-label", "Switch to dark theme")
    assert page.evaluate("document.documentElement.dataset.theme") == "light"


def test_manual_theme_choice_survives_reload(browser):
    page = browser.new_page(color_scheme="light")

    def respond(route):
        url = route.request.url
        if url == "https://dashboard.test/":
            route.fulfill(content_type="text/html", body=(ROOT / "index.html").read_text())
        elif url == "https://dashboard.test/styles.css":
            route.fulfill(content_type="text/css", body=STYLES)
        elif url == "https://dashboard.test/config.js":
            route.fulfill(content_type="text/javascript", body="")
        elif url.startswith("https://cdn.jsdelivr.net/"):
            route.fulfill(content_type="text/javascript", body=MOCK)
        elif url == "https://dashboard.test/app.js":
            route.fulfill(content_type="text/javascript", body=APP)
        else:
            route.abort()

    page.route("**/*", respond)
    page.goto("https://dashboard.test/")
    expect(page.locator("#live-text")).to_contain_text("Updated")
    page.locator("#theme-toggle").click()
    assert page.evaluate("localStorage.getItem('theme')") == "dark"
    page.reload()
    expect(page.locator("#theme-toggle")).to_have_attribute("aria-label", "Switch to light theme")
    expect(page.locator("#theme-icon-sun")).to_be_visible()
    assert page.evaluate("document.documentElement.dataset.theme") == "dark"

    page.emulate_media(color_scheme="dark")
    page.locator("#theme-toggle").click()
    assert page.evaluate("localStorage.getItem('theme')") == "light"
    page.reload()
    expect(page.locator("#theme-toggle")).to_have_attribute("aria-label", "Switch to dark theme")
    expect(page.locator("#theme-icon-moon")).to_be_visible()
    expect(page.locator("body")).to_have_css("background-color", "rgb(247, 249, 251)")
    expect(page.locator("#active-worker")).to_have_css("border-top-color", "rgb(114, 140, 150)")
    assert page.evaluate("document.documentElement.dataset.theme") == "light"

    page.evaluate("localStorage.setItem('theme', 'system')")
    page.reload()
    expect(page.locator("#theme-toggle")).to_have_attribute("aria-label", "Switch to light theme")
    page.locator("#theme-toggle").click()
    expect(page.locator("body")).to_have_css("background-color", "rgb(247, 249, 251)")
    assert page.evaluate("localStorage.getItem('theme')") == "light"
    page.close()


def test_theme_palette_has_readable_text_and_touch_targets(page):
    def luminance(value):
        channels = [int(value[index:index + 2], 16) / 255 for index in (1, 3, 5)]
        linear = [channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4 for channel in channels]
        return sum(channel * weight for channel, weight in zip(linear, (0.2126, 0.7152, 0.0722)))

    pairs = [("--ink", "--bg"), ("--ink", "--surface"), ("--muted", "--bg"), ("--muted", "--surface-2"),
             ("--accent", "--bg"), ("--accent", "--surface"), ("--accent", "--accent-soft"),
             ("--ok", "--ok-soft"), ("--warn", "--warn-soft"), ("--bad", "--bad-soft"),
             ("--info", "--info-soft"), ("--selected-ink", "--selected-bg"),
             ("--accent-ink", "--action"), ("--accent-ink", "--action-hover")]
    for theme in ("light", "dark"):
        page.evaluate("theme => { document.documentElement.dataset.theme = theme; }", theme)
        colors = page.evaluate("""() => {
          const styles = getComputedStyle(document.documentElement);
          return Object.fromEntries(['--bg', '--ink', '--surface', '--muted', '--surface-2', '--accent', '--accent-soft',
            '--ok', '--ok-soft', '--warn', '--warn-soft', '--bad', '--bad-soft', '--info', '--info-soft',
            '--brand-moss', '--brand-ocean', '--brand-blue', '--brand-sky', '--brand-cloud', '--chart-fill', '--chart-other',
            '--control-line', '--accent-ink', '--action', '--action-hover', '--selected-ink', '--selected-bg', '--logo-ink']
            .map(name => [name, styles.getPropertyValue(name).trim().toLowerCase()]));
        }""")
        assert [colors[name] for name in ("--brand-moss", "--brand-ocean", "--brand-blue", "--brand-sky", "--brand-cloud")] == [
            "#687864", "#31708e", "#5085a5", "#8fc1e3", "#f7f9fb"]
        for foreground, background in pairs:
            low, high = sorted((luminance(colors[foreground]), luminance(colors[background])))
            assert (high + 0.05) / (low + 0.05) >= 4.5, (theme, foreground, background)
        for background in ("--bg", "--surface-2"):
            low, high = sorted((luminance(colors["--chart-fill"]), luminance(colors[background])))
            assert (high + 0.05) / (low + 0.05) >= 3, (theme, "--chart-fill", background)
        low, high = sorted((luminance(colors["--accent"]), luminance(colors["--chart-other"])))
        assert (high + 0.05) / (low + 0.05) >= 3, (theme, "chart segments")
        low, high = sorted((luminance(colors["--logo-ink"]), luminance(colors["--brand-moss"])))
        assert (high + 0.05) / (low + 0.05) >= 3, (theme, "logo")
        for background in ("--bg", "--surface", "--surface-2", "--accent-soft"):
            low, high = sorted((luminance(colors["--control-line"]), luminance(colors[background])))
            assert (high + 0.05) / (low + 0.05) >= 3, (theme, "--control-line", background)

    page.evaluate("document.documentElement.dataset.theme = 'light'")
    rendered = page.evaluate("""() => ({
      background: getComputedStyle(document.body).backgroundColor,
      logo: getComputedStyle(document.querySelector('.logo')).backgroundColor,
      card: getComputedStyle(document.querySelector('.summary-card')).backgroundColor,
      cardBorder: getComputedStyle(document.querySelector('.summary-card')).borderTopColor,
      action: getComputedStyle(document.querySelector('#place-search')).backgroundColor,
      avatar: getComputedStyle(document.querySelector('.worker-avatar')).backgroundColor,
      navigation: getComputedStyle(document.querySelector('.tab.active'), '::after').backgroundColor,
    })""")
    assert rendered == {
        "background": "rgb(247, 249, 251)",
        "logo": "rgb(104, 120, 100)",
        "card": "rgb(255, 255, 255)",
        "cardBorder": "rgb(197, 217, 225)",
        "action": "rgb(49, 112, 142)",
        "avatar": "rgb(229, 241, 248)",
        "navigation": "rgb(80, 133, 165)",
    }
    page.evaluate("document.documentElement.dataset.theme = 'dark'")
    dark_rendered = page.evaluate("""() => ({
      background: getComputedStyle(document.body).backgroundColor,
      card: getComputedStyle(document.querySelector('.summary-card')).backgroundColor,
      action: getComputedStyle(document.querySelector('#place-search')).backgroundColor,
      actionText: getComputedStyle(document.querySelector('#place-search')).color,
      navigation: getComputedStyle(document.querySelector('.tab.active'), '::after').backgroundColor,
    })""")
    assert dark_rendered == {
        "background": "rgb(22, 42, 52)",
        "card": "rgb(34, 63, 77)",
        "action": "rgb(143, 193, 227)",
        "actionText": "rgb(23, 49, 63)",
        "navigation": "rgb(143, 193, 227)",
    }
    page.evaluate("document.documentElement.dataset.theme = 'light'")
    show(page, "places")
    for selector in ("#active-worker", "#refresh", "#theme-toggle", "#place-query", "#place-outcome", "#places-next"):
        expect(page.locator(selector)).to_have_css("border-top-color", "rgb(114, 140, 150)")
    page.locator("#place-search").hover()
    expect(page.locator("#place-search")).to_have_css("background-color", "rgb(33, 77, 100)")
    expect(page.locator("#place-search")).to_have_css("color", "rgb(255, 255, 255)")

    page.emulate_media(color_scheme="dark")
    page.evaluate("delete document.documentElement.dataset.theme")
    system_dark = page.evaluate("getComputedStyle(document.body).backgroundColor")
    expect(page.locator("#place-search")).to_have_css("background-color", "rgb(201, 229, 247)")
    expect(page.locator("#place-search")).to_have_css("color", "rgb(23, 49, 63)")
    page.evaluate("document.documentElement.dataset.theme = 'dark'")
    assert page.evaluate("getComputedStyle(document.body).backgroundColor") == system_dark
    assert system_dark != rendered["background"]

    page.set_viewport_size({"width": 375, "height": 900})
    for selector in ("#theme-toggle", "#refresh", "#active-worker"):
        box = page.locator(selector).bounding_box()
        assert box["width"] >= 44 and box["height"] >= 44, selector


def test_dashboard_navigation_is_keyboard_accessible(page):
    skip = page.get_by_role("link", name="Skip to dashboard content")
    skip.focus()
    page.keyboard.press("Enter")
    expect(page.locator("#main-content")).to_be_focused()
    overview = page.locator('button[data-view="overview"]')
    places = page.locator('button[data-view="places"]')
    overview.focus()
    page.keyboard.press("Tab")
    expect(places).to_be_focused()
    page.keyboard.press("Enter")
    expect(page.locator("#places-view")).to_be_visible()
    expect(places).to_have_attribute("aria-pressed", "true")
    expect(overview).to_have_attribute("aria-pressed", "false")


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_worker_picker_uses_theme_and_supports_keyboard(page, theme):
    page.evaluate("theme => { document.documentElement.dataset.theme = theme; }", theme)
    picker = page.locator("#active-worker")
    worker_a = page.evaluate("window.monitoringTest.state.workerA")
    picker.focus()
    expect(picker).to_be_focused()
    expect(picker).to_have_css("outline-style", "solid")
    page.keyboard.press("Enter")

    if page.evaluate("CSS.supports('appearance', 'base-select') && CSS.supports('selector(::picker(select))') && matchMedia('(hover: hover) and (pointer: fine)').matches"):
        assert picker.evaluate("node => node.matches(':open')")
        expected_surface = "rgb(255, 255, 255)" if theme == "light" else "rgb(34, 63, 77)"
        assert picker.evaluate("node => getComputedStyle(node, '::picker(select)').backgroundColor") == expected_surface
        expect(picker.locator("option:checked")).to_have_css("background-color", "rgb(198, 226, 243)")
        expect(picker.locator("option:checked")).to_have_css("color", "rgb(32, 49, 60)")

    page.keyboard.press("ArrowDown")
    page.keyboard.press("Enter")
    expect(picker).to_have_value(worker_a)
    expect(page.locator("#log-worker")).to_have_value(worker_a)
    page.keyboard.press("Enter")
    page.keyboard.press("Escape")
    expect(picker).to_have_value(worker_a)
    expect(picker).to_be_focused()


def test_touch_device_keeps_native_worker_picker(browser):
    page = browser.new_page(viewport={"width": 375, "height": 900}, is_mobile=True, has_touch=True)
    page.route("**/*", lambda route: route.abort())
    page.set_content(HTML)
    page.add_style_tag(content=STYLES)
    page.add_script_tag(content=MOCK)
    page.add_script_tag(content=APP)
    expect(page.locator("#live-text")).to_contain_text("Updated")
    assert page.evaluate("matchMedia('(pointer: coarse)').matches")
    expect(page.locator("#active-worker")).to_have_css("appearance", "auto")
    worker_b = page.evaluate("window.monitoringTest.state.workerB")
    page.locator("#active-worker").select_option(worker_b)
    expect(page.locator("#log-worker")).to_have_value(worker_b)
    page.close()


def test_worker_picker_handles_long_names_and_many_options(page):
    page.set_viewport_size({"width": 375, "height": 700})
    page.evaluate("""() => {
      window.monitoringTest.state.workers = Array.from({length: 30}, (_, index) => ({
        worker_id: `worker-${index}`, display_name: `Worker ${index} ` + 'W'.repeat(200),
      }));
    }""")
    page.locator("#refresh").click()
    picker = page.locator("#active-worker")
    expect(picker.locator("option")).to_have_count(31)
    picker.click()
    if page.evaluate("CSS.supports('appearance', 'base-select') && CSS.supports('selector(::picker(select))') && matchMedia('(hover: hover) and (pointer: fine)').matches"):
        assert picker.evaluate("node => node.matches(':open')")
        height = picker.evaluate("node => parseFloat(getComputedStyle(node, '::picker(select)').height)")
        assert height <= 320
        option_box = picker.locator("option").first.bounding_box()
        assert option_box["x"] >= 0 and option_box["x"] + option_box["width"] <= 375
    page.keyboard.press("End")
    page.keyboard.press("Enter")
    expect(picker).to_have_value("worker-29")
    expect(picker).to_have_attribute("title", re.compile(r"^Worker 29 W{200}"))
    expect(page.locator("#log-worker")).to_have_attribute("title", re.compile(r"^Worker 29 W{200}"))
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    picker.click()
    if page.evaluate("CSS.supports('appearance', 'base-select') && CSS.supports('selector(::picker(select))') && matchMedia('(hover: hover) and (pointer: fine)').matches"):
        assert picker.evaluate("node => node.matches(':open')")
        selected_box = picker.locator("option:checked").bounding_box()
        assert selected_box["x"] >= 0 and selected_box["x"] + selected_box["width"] <= 375
    page.keyboard.press("Escape")


def test_filter_edits_apply_only_on_submit_and_reset_preserves_worker(page):
    worker_b = page.evaluate("window.monitoringTest.state.workerB")
    show(page, "places")
    page.locator("#active-worker").select_option(worker_b)
    expect(page.get_by_role("button", name="Worker B place")).to_be_visible()
    page.locator("#place-query").fill("not-found")
    before = page.evaluate("window.monitoringTest.state.requests.filter(r => r.kind === 'places').length")
    page.evaluate("window.monitoringTest.tick()")
    page.wait_for_function("before => window.monitoringTest.state.requests.filter(r => r.kind === 'places').length > before", arg=before)
    assert page.evaluate("window.monitoringTest.state.requests.filter(r => r.kind === 'places').at(-1).params.p_query") == ""
    expect(page.get_by_role("button", name="Worker B place")).to_be_visible()
    page.locator("#place-query").press("Enter")
    expect(page.get_by_role("region", name="Places table")).to_contain_text("No places match the current filters")
    page.get_by_role("form", name="Place filters").get_by_role("button", name="Reset filters").click()
    expect(page.locator("#place-query")).to_have_value("")
    expect(page.locator("#active-worker")).to_have_value(worker_b)
    expect(page.get_by_role("button", name="Worker B place")).to_be_visible()


def test_log_date_validation_and_filter_reset(page):
    show(page, "logs")
    expect(page.get_by_text("Event 000", exact=True)).to_be_visible()
    before = page.evaluate("window.monitoringTest.state.requests.filter(r => r.kind === 'logs').length")
    page.locator("#log-from").fill("2026-01-03T00:00")
    page.locator("#log-to").fill("2026-01-01T00:00")
    page.locator("#log-search").click()
    expect(page.locator("#log-date-error")).to_have_text("From must be on or before To.")
    expect(page.locator("#log-from")).to_have_attribute("aria-invalid", "true")
    expect(page.locator("#log-to")).to_have_attribute("aria-invalid", "true")
    assert page.evaluate("window.monitoringTest.state.requests.filter(r => r.kind === 'logs').length") == before
    expect(page.get_by_text("Event 000", exact=True)).to_be_visible()

    page.locator("#log-from").fill("2025-12-31T00:00")
    expect(page.locator("#log-date-error")).to_be_hidden()
    page.locator("#log-severity").select_option("warning")
    page.locator("#log-search").click()
    expect(page.get_by_role("region", name="Operational logs table")).to_contain_text("No events match the current filters")
    page.locator("#log-severity").select_option("info")
    before = page.evaluate("window.monitoringTest.state.requests.filter(r => r.kind === 'logs').length")
    page.evaluate("window.monitoringTest.tick()")
    page.wait_for_function("before => window.monitoringTest.state.requests.filter(r => r.kind === 'logs').length > before", arg=before)
    assert page.evaluate("window.monitoringTest.state.requests.filter(r => r.kind === 'logs').at(-1).params.filters.severity") == "warning"
    expect(page.get_by_role("region", name="Operational logs table")).to_contain_text("No events match the current filters")
    page.locator("#log-reset").click()
    expect(page.locator("#log-from")).to_have_value("")
    expect(page.locator("#log-to")).to_have_value("")
    expect(page.locator("#log-severity")).to_have_value("")
    expect(page.get_by_text("Event 000", exact=True)).to_be_visible()


def test_place_loading_failure_is_visible_and_recoverable(page):
    hold(page, "places")
    show(page, "places")
    request_id = pending(page, "places")
    expect(page.locator("#places-view")).to_have_attribute("aria-busy", "true")
    expect(page.locator("#live-text")).to_have_text("Updating…")
    expect(page.locator("#places-table")).to_contain_text("Loading places…")
    finish(page, request_id, "Places unavailable")
    expect(page.locator("#global-error")).to_have_text("Places unavailable")
    expect(page.locator("#stale-note")).to_be_hidden()
    expect(page.locator("#places-table")).to_contain_text("Unable to load places")
    expect(page.locator("#places-view")).not_to_have_attribute("aria-busy", "true")
    page.locator("#place-search").click()
    expect(page.get_by_role("button", name="Place 000", exact=True)).to_be_visible()
    expect(page.locator("#global-error")).to_be_empty()


def test_manual_refresh_announces_progress_without_poll_announcements(page):
    announcement = page.locator("#refresh-announcement")
    hold(page, "overview")
    page.locator("#refresh").click()
    request_id = pending(page, "overview")
    expect(announcement).to_have_text("Refreshing dashboard…")
    finish(page, request_id)
    expect(announcement).to_have_text("Dashboard updated.")
    page.evaluate("window.monitoringTest.tick()")
    expect(page.locator("#live-text")).to_contain_text("Updated")
    expect(announcement).to_have_text("Dashboard updated.")


def test_missing_library_replaces_initial_loading_message(browser):
    page = browser.new_page()
    page.route("**/*", lambda route: route.abort())
    page.set_content(HTML)
    page.add_script_tag(content=APP)
    expect(page.locator("#global-error")).to_have_text("Supabase browser library did not load.")
    expect(page.locator("#overview-view")).to_contain_text("Unable to load overview. Reload the page to retry.")
    page.close()


def test_refresh_preserves_place_focus_and_dialog_context(page):
    show(page, "places")
    place = page.get_by_role("button", name="Place 000", exact=True)
    expect(place).to_be_visible()
    place.focus()
    hold(page, "places")
    page.evaluate("window.monitoringTest.tick()")
    finish(page, pending(page, "places"))
    expect(place).to_be_focused()

    place.press("Enter")
    dialog = page.get_by_role("dialog", name=re.compile("Place 000"))
    history = dialog.get_by_role("region", name="Attempt history table")
    summary = history.locator("tbody tr").first.locator("summary")
    summary.click()
    expect(summary).to_be_focused()
    expect(summary.locator("..")).to_have_attribute("open", "")
    hold(page, "attempts")
    page.evaluate("window.monitoringTest.tick()")
    finish(page, pending(page, "attempts"))
    expect(summary).to_be_focused()
    expect(summary.locator("..")).to_have_attribute("open", "")
    page.keyboard.press("Escape")
    expect(dialog).to_be_hidden()
    expect(place).to_be_focused()
    page.evaluate("window.monitoringTest.state.places = []")
    hold(page, "places")
    page.evaluate("window.monitoringTest.tick()")
    finish(page, pending(page, "places"))
    expect(page.get_by_role("region", name="Places table")).to_be_focused()


def test_pending_nearest_match_is_labelled_and_requires_server_review(page):
    page.evaluate("""() => {
      const place = window.monitoringTest.state.places[0];
      place.outcome = 'ambiguous';
      place.queue_status = 'retry_wait';
      place.review_flag = true;
      place.google_proposal = {selection_method: 'nearest_suggestion', review_status: 'pending',
                               suggestion_id: 'example-review-id'};
    }""")
    show(page, "places")
    page.get_by_role("button", name="Place 000", exact=True).click()
    dialog = page.get_by_role("dialog", name=re.compile("Place 000"))
    expect(dialog).to_contain_text("Suggested nearest match — awaiting review")
    expect(dialog).to_contain_text("excluded from exports until approved")
    expect(dialog).to_contain_text("example-review-id")
    expect(dialog.get_by_role("button", name=re.compile("approve", re.IGNORECASE))).to_have_count(0)


def test_refresh_preserves_expanded_log_details_and_focus(page):
    show(page, "logs")
    table = page.get_by_role("region", name="Operational logs table")
    summary = table.locator("tbody tr").first.locator("summary")
    summary.click()
    expect(summary).to_be_focused()
    hold(page, "logs")
    page.evaluate("window.monitoringTest.tick()")
    finish(page, pending(page, "logs"))
    expect(summary).to_be_focused()
    expect(summary.locator("..")).to_have_attribute("open", "")


def test_long_content_and_large_text_do_not_overflow(page):
    page.set_viewport_size({"width": 360, "height": 900})
    page.evaluate("""() => {
      document.documentElement.style.fontSize = '200%';
      const state = window.monitoringTest.state;
      state.workers[0].display_name = 'Worker-' + 'W'.repeat(200);
      state.workers[0].current_state.pause_reason = 'Reason-' + 'R'.repeat(200);
      state.places[0].source_record.name = 'Place-' + 'P'.repeat(200);
    }""")
    page.locator("#refresh").click()
    expect(page.locator(".worker-name").first).to_contain_text("Worker-")
    for view in ("overview", "places", "logs"):
        show(page, view)
        expect(page.locator(f"#{view}-view")).to_be_visible()
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), view
    show(page, "places")
    page.get_by_role("button", name="Place-" + "P" * 200, exact=True).click()
    dialog = page.get_by_role("dialog")
    expect(dialog).to_be_visible()
    assert dialog.evaluate("node => node.scrollWidth <= node.clientWidth")


def test_mobile_tables_and_place_dialog_are_accessible(page):
    page.set_viewport_size({"width": 375, "height": 900})
    show(page, "places")
    region = page.get_by_role("region", name="Places table")
    expect(region).to_have_attribute("tabindex", "0")
    expect(region.locator(".table-scroll-hint")).to_be_visible()
    expect(region.locator(".pill").first).to_have_css("white-space", "nowrap")
    place_box = page.get_by_role("button", name="Place 000", exact=True).bounding_box()
    assert place_box["width"] >= 44 and place_box["height"] >= 44
    assert region.evaluate("node => node.scrollWidth > node.clientWidth")
    region.focus()
    page.keyboard.press("ArrowRight")
    page.wait_for_function("document.querySelector('#places-table .table-wrap').scrollLeft > 0")

    page.get_by_role("button", name="Place 000", exact=True).click()
    dialog = page.get_by_role("dialog", name=re.compile("Place 000"))
    expect(dialog).to_be_visible()
    expect(dialog.get_by_role("region", name="Attempt history table")).to_have_attribute("tabindex", "0")
    page.locator("#detail-close").click()
    show(page, "logs")
    expect(page.get_by_role("region", name="Operational logs table")).to_have_attribute("tabindex", "0")
    detail_box = page.locator("#logs-table summary").first.bounding_box()
    assert detail_box["width"] >= 44 and detail_box["height"] >= 44


@pytest.mark.parametrize(("theme", "width"), [("light", 1440), ("dark", 375)])
def test_place_attempt_history_shows_processing_durations(page, theme, width):
    page.set_viewport_size({"width": width, "height": 900})
    page.evaluate("theme => { document.documentElement.dataset.theme = theme; }", theme)
    page.evaluate("""() => {
      const state = window.monitoringTest.state;
      const start = '2026-11-03T00:00:00.000Z';
      const cases = [
        ['zero', start, start],
        ['subsecond', start, '2026-11-03T00:00:00.030Z'],
        ['seconds', start, '2026-11-03T00:00:01.234Z'],
        ['timezone', '2026-11-03T07:00:00.123456+07:00', '2026-11-03T00:00:01.789012+00:00'],
        ['minute', start, '2026-11-03T00:01:02.345Z'],
        ['long', start, '2026-11-03T01:01:02.345Z'],
        ['rounding', start, '2026-11-03T00:00:59.960Z'],
        ['missing-start', null, start],
        ['missing-end', start, null],
        ['invalid-start', 'invalid', start],
        ['invalid-end', start, 'invalid'],
        ['negative', '2026-11-03T00:00:01.000Z', start],
      ];
      state.attempts = cases.map(([name, started, completed]) => ({
        worker_id: state.workerA, osm_id: 'node/000', attempt_id: name,
        status: 'checked', outcome: 'found', error_code: name,
        worker_started_at: started, worker_completed_at: completed,
      }));
    }""")

    show(page, "places")
    page.get_by_role("button", name="Place 000", exact=True).click()
    dialog = page.get_by_role("dialog", name=re.compile("Place 000"))
    expect(dialog).to_be_visible()
    expect(dialog).to_contain_text("queue time is excluded")
    history = dialog.get_by_role("region", name="Attempt history table")
    expect(history.get_by_role("columnheader", name="Duration")).to_be_visible()
    for name, expected in (
        ("zero", "0 s"), ("subsecond", "<0.1 s"), ("seconds", "1.2 s"), ("timezone", "1.7 s"),
        ("minute", "1 min 2.3 s"), ("long", "61 min 2.3 s"), ("rounding", "1 min 0 s"),
        ("missing-start", "—"), ("missing-end", "—"), ("invalid-start", "—"),
        ("invalid-end", "—"), ("negative", "—"),
    ):
        row = history.get_by_role("row").filter(has=page.get_by_role("cell", name=name, exact=True))
        expect(row.locator("td").nth(1)).to_have_text(expected)
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")


@pytest.mark.parametrize("old_error", [False, True])
def test_older_place_response_cannot_replace_newer_search(page, old_error):
    show(page, "places")
    expect(page.get_by_role("button", name="Place 000", exact=True)).to_be_visible()
    hold(page, "places")
    page.locator("#place-query").fill("Place 000")
    page.locator("#place-search").click()
    old_request = pending(page, "places")

    page.locator("#place-query").fill("Place 001")
    page.locator("#place-search").click()
    expect(page.get_by_role("button", name="Place 001", exact=True)).to_be_visible()
    finish(page, old_request, "Old search failed" if old_error else "")

    expect(page.get_by_role("button", name="Place 001", exact=True)).to_be_visible()
    expect(page.get_by_role("button", name="Place 000", exact=True)).to_have_count(0)
    expect(page.locator("#places-page")).to_contain_text("Page 1 of 1")
    expect(page.locator("#global-error")).to_be_empty()


def test_current_error_is_reported_and_next_success_clears_it(page):
    show(page, "places")
    expect(page.locator("#places-page")).to_contain_text("Page 1 of 3")
    hold(page, "places")
    page.locator("#place-search").click()
    finish(page, pending(page, "places"), "Current search failed")
    expect(page.locator("#global-error")).to_have_text("Current search failed")
    expect(page.locator("#stale-note")).to_contain_text("may be out of date")
    expect(page.locator("#stale-note")).to_contain_text("Last updated")
    expect(page.locator("#stale-note")).to_be_visible()
    page.locator("#place-search").click()
    expect(page.locator("#global-error")).to_be_empty()
    expect(page.locator("#stale-note")).to_be_hidden()


def test_old_success_cannot_clear_newer_error(page):
    show(page, "places")
    expect(page.locator("#places-page")).to_contain_text("Page 1 of 3")
    hold(page, "places")
    page.locator("#place-query").fill("Place 000")
    page.locator("#place-search").click()
    old_request = pending(page, "places")
    hold(page, "places")
    page.locator("#place-query").fill("Place 001")
    page.locator("#place-search").click()
    page.wait_for_function("window.monitoringTest.pending().length === 2")
    new_request = page.evaluate("window.monitoringTest.pending().at(-1).id")
    finish(page, new_request, "New search failed")
    expect(page.locator("#global-error")).to_have_text("New search failed")
    finish(page, old_request)
    expect(page.locator("#global-error")).to_have_text("New search failed")


def test_switching_views_ignores_old_request_failure(page):
    show(page, "places")
    expect(page.locator("#places-page")).to_contain_text("Page 1 of 3")
    hold(page, "places")
    page.locator("#place-search").click()
    old_request = pending(page, "places")
    show(page, "logs")
    expect(page.get_by_text("Event 000", exact=True)).to_be_visible()
    finish(page, old_request, "Old view failed")
    expect(page.get_by_text("Event 000", exact=True)).to_be_visible()
    expect(page.locator("#global-error")).to_be_empty()


def test_older_logs_response_cannot_replace_newer_filter(page):
    show(page, "logs")
    expect(page.get_by_text("Event 000", exact=True)).to_be_visible()
    hold(page, "logs")
    page.locator("#log-severity").select_option("info")
    page.locator("#log-search").click()
    old_request = pending(page, "logs")
    page.locator("#log-severity").select_option("warning")
    page.locator("#log-search").click()
    expect(page.get_by_text("Worker B event", exact=True)).to_be_visible()
    finish(page, old_request)
    expect(page.get_by_text("Worker B event", exact=True)).to_be_visible()
    expect(page.get_by_text("Event 000", exact=True)).to_have_count(0)
    expect(page.locator("#logs-page")).to_contain_text("Page 1 of 1")


def test_worker_change_from_either_selector_resets_both_pages(page):
    worker_b = page.evaluate("window.monitoringTest.state.workerB")
    show(page, "places")
    expect(page.locator("#places-page")).to_contain_text("Page 1 of 3")
    page.locator("#places-next").click()
    expect(page.locator("#places-page")).to_contain_text("Page 2 of 3")
    show(page, "logs")
    page.locator("#log-worker").select_option(worker_b)
    show(page, "places")
    expect(page.get_by_role("button", name="Worker B place")).to_be_visible()
    expect(page.locator("#places-page")).to_contain_text("Page 1 of 1")
    assert request_offsets(page, "places")[-1] == 0

    page.locator("#active-worker").select_option("")
    show(page, "logs")
    expect(page.locator("#logs-page")).to_contain_text("Page 1 of 3")
    page.locator("#logs-next").click()
    expect(page.locator("#logs-page")).to_contain_text("Page 2 of 3")
    page.locator("#active-worker").select_option(worker_b)
    expect(page.locator("#logs-page")).to_contain_text("Page 1 of 1")
    expect(page.get_by_text("Worker B event", exact=True)).to_be_visible()
    assert request_offsets(page, "logs")[-1] == 0


@pytest.mark.parametrize("view", ["places", "logs"])
def test_shrinking_results_return_to_first_page(page, view):
    show(page, view)
    expect(page.locator(f"#{view}-page")).to_contain_text("Page 1 of 3")
    page.locator(f"#{view}-next").click()
    expect(page.locator(f"#{view}-page")).to_contain_text("Page 2 of 3")
    page.evaluate("view => { const state = window.monitoringTest.state; state[view] = state[view].slice(0, 1); }", view)
    page.locator("#refresh").click()
    expect(page.locator(f"#{view}-page")).to_contain_text("Page 1 of 1")
    assert request_offsets(page, view)[-2:] == [50, 0]
    expect(page.locator(f"#{view}-table").get_by_text("No records found.")).to_have_count(0)


def test_disappearing_worker_and_late_worker_refresh(page):
    worker_a = page.evaluate("window.monitoringTest.state.workerA")
    page.locator("#active-worker").select_option(worker_a)
    show(page, "places")
    expect(page.locator("#places-page")).to_contain_text("Page 1 of 3")
    page.locator("#places-next").click()
    expect(page.locator("#places-page")).to_contain_text("Page 2 of 3")
    hold(page, "workers")
    page.locator("#refresh").click()
    old_request = pending(page, "workers")
    page.evaluate("window.monitoringTest.state.workers = window.monitoringTest.state.workers.slice(-1)")
    page.locator("#refresh").click()
    expect(page.locator("#active-worker")).to_have_value("")
    expect(page.locator("#log-worker")).to_have_value("")
    expect(page.locator("#places-page")).to_contain_text("Page 1 of 3")
    assert request_offsets(page, "places")[-1] == 0
    finish(page, old_request)
    expect(page.locator(f'#active-worker option[value="{worker_a}"]')).to_have_count(0)
    expect(page.locator("#global-error")).to_be_empty()


def test_detail_paging_handles_shrinking_history(page):
    page.evaluate("""() => window.monitoringTest.state.attempts.forEach((attempt, index) => {
      attempt.worker_started_at = new Date(new Date(attempt.worker_completed_at).getTime() - (index + 1) * 1000).toISOString();
    })""")
    show(page, "places")
    page.get_by_role("button", name="Place 000", exact=True).click()
    expect(page.locator("#attempts-page")).to_contain_text("Page 1 of 3")
    expect(page.get_by_role("row").filter(has_text="Attempt 000").locator("td").nth(1)).to_have_text("1 s")
    page.locator("#attempts-next").click()
    expect(page.get_by_text("Attempt 050", exact=True)).to_be_visible()
    expect(page.get_by_role("row").filter(has_text="Attempt 050").locator("td").nth(1)).to_have_text("51 s")
    page.evaluate("window.monitoringTest.state.attempts = window.monitoringTest.state.attempts.slice(0, 1)")
    page.evaluate("window.monitoringTest.tick()")
    expect(page.locator("#attempts-page")).to_contain_text("Page 1 of 1")
    assert request_offsets(page, "attempts")[-2:] == [50, 0]
    expect(page.get_by_text("Attempt 000", exact=True)).to_be_visible()


def test_closed_detail_ignores_late_failure_and_reopens(page):
    show(page, "places")
    page.get_by_role("button", name="Place 000", exact=True).click()
    expect(page.locator("#attempts-page")).to_contain_text("Page 1 of 3")
    hold(page, "attempts")
    page.locator("#attempts-next").click()
    old_request = pending(page, "attempts")
    page.locator("#detail-close").click()
    finish(page, old_request, "Old detail failed")
    expect(page.locator("#global-error")).to_be_empty()
    page.get_by_role("button", name="Place 000", exact=True).click()
    expect(page.locator("#attempts-page")).to_contain_text("Page 1 of 3")
    expect(page.locator("#detail-error")).to_be_empty()


def test_older_detail_failure_cannot_replace_newer_page(page):
    show(page, "places")
    page.get_by_role("button", name="Place 000", exact=True).click()
    expect(page.locator("#attempts-page")).to_contain_text("Page 1 of 3")
    hold(page, "attempts")
    page.locator("#attempts-next").click()
    old_request = pending(page, "attempts")
    page.locator("#attempts-next").click()
    expect(page.locator("#attempts-page")).to_contain_text("Page 2 of 3")
    finish(page, old_request, "Old attempt request failed")
    expect(page.get_by_text("Attempt 050", exact=True)).to_be_visible()
    expect(page.locator("#detail-error")).to_be_empty()
    expect(page.locator("#global-error")).to_be_empty()


def test_current_detail_error_is_visible_inside_dialog(page):
    show(page, "places")
    hold(page, "attempts")
    page.get_by_role("button", name="Place 000", exact=True).click()
    finish(page, pending(page, "attempts"), "Attempt history unavailable")
    expect(page.locator("#detail-error")).to_have_text("Attempt history unavailable")
    expect(page.locator("#detail-content")).to_contain_text("Try again")
    expect(page.locator("#attempts-page")).to_have_text("Unavailable")
    hold(page, "attempts")
    page.get_by_role("button", name="Retry loading details").click()
    request_id = pending(page, "attempts")
    expect(page.get_by_role("button", name="Retry loading details")).to_be_disabled()
    expect(page.locator("#attempts-table")).to_have_attribute("aria-busy", "true")
    finish(page, request_id)
    expect(page.locator("#detail-error")).to_be_empty()
    expect(page.locator("#attempts-page")).to_contain_text("Page 1 of 3")
    expect(page.get_by_role("button", name="Retry loading details")).to_be_hidden()
    expect(page.locator("#detail-close")).to_be_focused()


def test_polling_and_visibility_do_not_apply_stale_results(page):
    show(page, "places")
    expect(page.locator("#places-page")).to_contain_text("Page 1 of 3")
    assert page.evaluate("window.monitoringTest.timerCount()") == 1
    hold(page, "places")
    page.evaluate("window.monitoringTest.tick()")
    old_poll = pending(page, "places")
    page.locator("#place-query").fill("Place 001")
    page.locator("#place-search").click()
    expect(page.get_by_role("button", name="Place 001", exact=True)).to_be_visible()
    finish(page, old_poll)
    expect(page.get_by_role("button", name="Place 001", exact=True)).to_be_visible()

    hold(page, "places")
    page.locator("#place-query").fill("Place 000")
    page.locator("#place-search").click()
    hidden_request = pending(page, "places")
    page.evaluate("window.monitoringTest.setHidden(true)")
    assert page.evaluate("window.monitoringTest.timerCount()") == 0
    requests_before_tick = page.evaluate("window.monitoringTest.state.requests.length")
    page.evaluate("window.monitoringTest.tick()")
    assert page.evaluate("window.monitoringTest.state.requests.length") == requests_before_tick
    finish(page, hidden_request, "Hidden request failed")
    expect(page.locator("#global-error")).to_be_empty()
    expect(page.get_by_role("button", name="Place 001", exact=True)).to_be_visible()
    page.evaluate("window.monitoringTest.setHidden(false)")
    expect(page.get_by_role("button", name="Place 000", exact=True)).to_be_visible()
    assert page.evaluate("window.monitoringTest.timerCount()") == 1


def test_overview_reuses_workers_and_polls_every_five_minutes(page):
    assert page.evaluate("window.monitoringTest.timerDelays()") == [300_000]
    initial = page.evaluate("window.monitoringTest.state.requests")
    assert sum(request["kind"] == "overview" for request in initial) == 1
    assert not any(request["kind"] == "workers" for request in initial)
    assert len([request for request in initial if request["kind"].startswith("metric-")]) == 5
    assert all(request["params"]["head"] for request in initial if request["kind"].startswith("metric-"))

    page.evaluate("window.monitoringTest.tick()")
    page.wait_for_function("window.monitoringTest.state.requests.filter(r => r.kind === 'overview').length === 2")
    page.wait_for_function("window.monitoringTest.state.requests.filter(r => r.kind.startsWith('metric-')).length === 10")
    requests = page.evaluate("window.monitoringTest.state.requests")
    assert not any(request["kind"] == "workers" for request in requests)
    expect(page.locator(".nav-meta")).to_contain_text("5 MIN")


def test_ten_minute_heartbeat_boundary(page):
    page.evaluate("""() => {
      const now = Date.now();
      Date.now = () => now;
      const workers = window.monitoringTest.state.workers;
      workers[0].last_heartbeat_at = new Date(now - 599999).toISOString();
      workers[1].last_heartbeat_at = new Date(now - 600000).toISOString();
    }""")
    page.locator("#refresh").click()
    expect(metric(page, "workers").locator(".summary-value")).to_have_text("1 / 2")
    expect(page.locator(".worker-panel").filter(has_text="Worker A")).to_contain_text("Heartbeat recent")
    expect(page.locator(".worker-panel").filter(has_text="Worker B")).to_contain_text("Worker not reporting")
    expect(page.locator(".worker-section-note")).to_contain_text("10 minutes")


def test_place_list_uses_small_responses_and_preserves_search_behavior(page):
    page.evaluate("""() => {
      const state = window.monitoringTest.state;
      state.places.slice(0, 50).forEach(place => {
        place.source_record.extra = 'source-'.repeat(500);
        place.candidates = [{ evidence: 'candidate-'.repeat(500) }];
        place.google_proposal = { evidence: 'proposal-'.repeat(500) };
      });
      state.places[0].source_record.name = 'Café (North)';
    }""")
    show(page, "places")
    expect(page.get_by_role("button", name="Café (North)", exact=True)).to_be_visible()
    request = page.evaluate("window.monitoringTest.state.requests.filter(r => r.kind === 'places').at(-1)")
    original_bytes = page.evaluate(
        "new TextEncoder().encode(JSON.stringify(window.monitoringTest.state.places.slice(0, 50))).length"
    )
    assert request["params"]["via"] == "table"
    assert "name:source_record->>name" in request["params"]["columns"]
    assert "candidates" not in request["params"]["columns"]
    assert "google_proposal" not in request["params"]["columns"]
    assert request["bodyBytes"] < original_bytes / 10
    assert not page.evaluate("window.monitoringTest.state.requests.some(r => r.kind === 'place-detail')")

    page.locator("#place-query").fill("Café")
    page.locator("#place-search").click()
    expect(page.locator("#places-page")).to_contain_text("Page 1 of 1")
    assert page.evaluate("window.monitoringTest.state.requests.filter(r => r.kind === 'places').at(-1).params.via") == "table"
    expect(page.get_by_role("button", name="Café (North)", exact=True)).to_be_visible()

    page.locator("#place-query").fill("Café (North)")
    page.locator("#place-search").click()
    expect(page.get_by_role("button", name="Café (North)", exact=True)).to_be_visible()
    assert page.evaluate("window.monitoringTest.state.requests.filter(r => r.kind === 'places').at(-1).params.via") == "rpc"
    page.locator("#place-query").fill("%")
    page.locator("#place-search").click()
    expect(page.locator("#places-page")).to_contain_text("Page 1 of 3")
    assert page.evaluate("window.monitoringTest.state.requests.filter(r => r.kind === 'places').at(-1).params.via") == "rpc"


def test_place_details_load_on_open_and_retry(page):
    page.evaluate("""() => {
      const place = window.monitoringTest.state.places[0];
      place.google_proposal = { name: 'Detailed proposal' };
      place.candidates = [{ name: 'Detailed candidate' }];
    }""")
    show(page, "places")
    assert not page.evaluate("window.monitoringTest.state.requests.some(r => r.kind === 'place-detail')")
    hold(page, "place-detail")
    page.get_by_role("button", name="Place 000", exact=True).click()
    request_id = pending(page, "place-detail")
    expect(page.locator("#detail-content")).to_contain_text("Loading place details")
    finish(page, request_id, "Place details unavailable")
    expect(page.locator("#detail-error")).to_have_text("Place details unavailable")
    page.locator("#detail-retry").click()
    expect(page.locator("#detail-content")).to_contain_text("Detailed proposal")
    expect(page.locator("#detail-content")).to_contain_text("Detailed candidate")
    expect(page.locator("#attempts-page")).to_contain_text("Page 1 of 3")


def test_log_details_are_lazy_retried_and_cached(page):
    page.evaluate("""() => {
      const logs = window.monitoringTest.state.logs;
      logs.slice(0, 50).forEach(log => { log.data = {payload: 'data-'.repeat(1000)}; });
      logs[0].data = {payload: 'log evidence ' + 'data-'.repeat(1000)};
    }""")
    show(page, "logs")
    table = page.get_by_role("region", name="Operational logs table")
    details = table.locator("tbody tr").first.locator("details")
    request = page.evaluate("window.monitoringTest.state.requests.filter(r => r.kind === 'logs').at(-1)")
    assert "data" not in request["params"]["columns"].split(",")
    original_bytes = page.evaluate(
        "new TextEncoder().encode(JSON.stringify(window.monitoringTest.state.logs.slice(0, 50))).length"
    )
    assert request["bodyBytes"] < original_bytes / 10
    assert not page.evaluate("window.monitoringTest.state.requests.some(r => r.kind === 'log-detail')")

    hold(page, "log-detail")
    details.locator("summary").click()
    request_id = pending(page, "log-detail")
    expect(details).to_contain_text("Loading details")
    finish(page, request_id, "Log detail unavailable")
    expect(details.get_by_role("alert")).to_have_text("Log detail unavailable")
    details.get_by_role("button", name="Retry loading details").click()
    expect(details.locator("summary")).to_be_focused()
    expect(details.locator("pre")).to_contain_text("log evidence")
    before = page.evaluate("window.monitoringTest.state.requests.filter(r => r.kind === 'log-detail').length")
    assert before == 2
    hold(page, "logs")
    page.evaluate("window.monitoringTest.tick()")
    finish(page, pending(page, "logs"))
    expect(details).to_have_attribute("open", "")
    expect(details.locator("pre")).to_contain_text("log evidence")
    assert page.evaluate("window.monitoringTest.state.requests.filter(r => r.kind === 'log-detail').length") == before


def test_attempt_evidence_is_lazy_and_cached(page):
    page.evaluate("""() => {
      const attempts = window.monitoringTest.state.attempts;
      attempts.slice(0, 50).forEach(item => { item.candidates = [{ evidence: 'data-'.repeat(1000) }]; });
      const attempt = attempts[0];
      attempt.candidates = [{ name: 'candidate evidence' }];
      attempt.proposal = { name: 'proposal evidence' };
      attempt.errors = [{ message: 'error evidence' }];
    }""")
    show(page, "places")
    page.get_by_role("button", name="Place 000", exact=True).click()
    expect(page.locator("#attempts-page")).to_contain_text("Page 1 of 3")
    request = page.evaluate("window.monitoringTest.state.requests.filter(r => r.kind === 'attempts').at(-1)")
    assert not {"candidates", "proposal", "errors"} & set(request["params"]["columns"].split(","))
    original_bytes = page.evaluate(
        "new TextEncoder().encode(JSON.stringify(window.monitoringTest.state.attempts.slice(0, 50))).length"
    )
    assert request["bodyBytes"] < original_bytes / 10
    assert not page.evaluate("window.monitoringTest.state.requests.some(r => r.kind === 'attempt-evidence')")
    details = page.locator("#attempts-table tbody tr").first.locator("details")
    details.locator("summary").click()
    expect(details.locator("pre")).to_contain_text("candidate evidence")
    expect(details.locator("pre")).to_contain_text("proposal evidence")
    expect(details.locator("pre")).to_contain_text("error evidence")
    assert page.evaluate("window.monitoringTest.state.requests.filter(r => r.kind === 'attempt-evidence').length") == 1
    hold(page, "attempts")
    page.evaluate("window.monitoringTest.tick()")
    finish(page, pending(page, "attempts"))
    expect(details).to_have_attribute("open", "")
    expect(details.locator("pre")).to_contain_text("candidate evidence")
    assert page.evaluate("window.monitoringTest.state.requests.filter(r => r.kind === 'attempt-evidence').length") == 1


def test_inflight_log_detail_is_shared_across_refresh(page):
    page.evaluate("window.monitoringTest.state.logs[0].data = {payload: 'late evidence'}")
    show(page, "logs")
    details = page.locator("#logs-table tbody tr").first.locator("details")
    hold(page, "log-detail")
    details.locator("summary").click()
    request_id = pending(page, "log-detail")
    hold(page, "logs")
    page.evaluate("window.monitoringTest.tick()")
    finish(page, pending(page, "logs"))
    expect(details).to_have_attribute("open", "")
    finish(page, request_id)
    expect(details.locator("pre")).to_contain_text("late evidence")
    assert page.evaluate("window.monitoringTest.state.requests.filter(r => r.kind === 'log-detail').length") == 1


def test_removed_selected_worker_refreshes_overview_for_all_workers(page):
    worker_a = page.evaluate("window.monitoringTest.state.workerA")
    page.locator("#active-worker").select_option(worker_a)
    expect(page.locator(".worker-panel")).to_have_count(1)
    hold(page, "overview")
    page.locator("#refresh").click()
    old_request = pending(page, "overview")
    page.evaluate("window.monitoringTest.state.workers = window.monitoringTest.state.workers.slice(1)")
    page.locator("#refresh").click()
    expect(page.locator("#active-worker")).to_have_value("")
    expect(page.locator(".worker-panel")).to_have_count(1)
    expect(page.locator(".worker-panel")).to_contain_text("Worker B")
    finish(page, old_request)
    expect(page.locator(f'#active-worker option[value="{worker_a}"]')).to_have_count(0)
    expect(page.locator(".worker-panel")).to_contain_text("Worker B")


def test_place_time_chart_compares_latest_recorded_attempts(page):
    seed_place_times(page)
    show(page, "places")
    chart = page.get_by_role("region", name="Inspection time by place")
    expect(chart).to_contain_text("Queue time is excluded")
    expect(chart).to_contain_text("4 of 7 places have a recorded time")
    expect(chart).to_contain_text("3 unavailable")
    rows = chart.locator(".place-time-item")
    expect(rows).to_have_count(4)
    for index, (name, duration, width) in enumerate((
        ("Slow place", "10 s", "100%"),
        ("Other worker place", "5 s", "50%"),
        ("Quick place", "2 s", "20%"),
        ("Zero place", "0 s", "0%"),
    )):
        expect(rows.nth(index)).to_contain_text(name)
        expect(rows.nth(index).locator(".place-time-value")).to_have_text(duration)
        assert rows.nth(index).locator(".chart-bar-fill").evaluate("node => node.style.width") == width

    request = page.evaluate("window.monitoringTest.state.requests.filter(r => r.kind === 'place-times').at(-1)")
    assert request["params"]["columns"] == "worker_id,attempt_id,osm_id,worker_started_at,worker_completed_at"
    assert len(request["params"]["timePairs"]) == 7
    assert len({pair["worker_id"] for pair in request["params"]["timePairs"]}) == 2

    worker_a = page.evaluate("window.monitoringTest.state.workerA")
    page.locator("#active-worker").select_option(worker_a)
    expect(chart).to_contain_text("3 of 6 places have a recorded time")
    expect(chart).not_to_contain_text("Other worker place")
    page.locator("#place-query").fill("Slow place")
    page.locator("#place-search").click()
    expect(chart).to_contain_text("1 of 1 place has a recorded time")
    expect(chart.locator(".place-time-item")).to_have_count(1)
    expect(chart).to_contain_text("Slow place")
    page.locator("#place-query").fill("Zero place")
    page.locator("#place-search").click()
    expect(chart).to_contain_text("Zero place")
    expect(chart.locator(".place-time-value")).to_have_text("0 s")
    assert chart.locator(".chart-bar-fill").evaluate("node => node.style.width") == "0%"


def test_place_time_chart_skips_missing_and_invalid_attempt_ids(page):
    page.evaluate("""() => {
      const state = window.monitoringTest.state;
      state.places = state.places.slice(0, 2);
      state.places[0].latest_attempt_id = null;
      state.places[1].latest_attempt_id = 'invalid),worker_id.eq.anything';
    }""")
    show(page, "places")
    chart = page.get_by_role("region", name="Inspection time by place")
    expect(chart).to_contain_text("No completed inspection times are available")
    assert not page.evaluate("window.monitoringTest.state.requests.some(r => r.kind === 'place-times')")


def test_place_time_chart_caches_records_and_retries_pending_attempts(page):
    seed_place_times(page)
    show(page, "places")
    chart = page.get_by_role("region", name="Inspection time by place")
    expect(chart).to_contain_text("4 of 7 places have a recorded time")
    page.evaluate("window.monitoringTest.tick()")
    page.wait_for_function("window.monitoringTest.state.requests.filter(r => r.kind === 'place-times').length === 2")
    request = page.evaluate("window.monitoringTest.state.requests.filter(r => r.kind === 'place-times').at(-1)")
    assert len(request["params"]["timePairs"]) == 1
    assert request["params"]["timePairs"][0]["attempt_id"].endswith("000000000004")

    page.evaluate("""() => {
      const state = window.monitoringTest.state;
      state.attempts.push({
        worker_id: state.workerA, osm_id: 'node/5',
        attempt_id: '00000000-0000-4000-8000-000000000004',
        worker_started_at: '2026-11-03T00:00:00.000Z',
        worker_completed_at: '2026-11-03T00:00:04.000Z',
      });
    }""")
    page.evaluate("window.monitoringTest.tick()")
    expect(chart).to_contain_text("5 of 7 places have a recorded time")
    before = page.evaluate("window.monitoringTest.state.requests.filter(r => r.kind === 'place-times').length")
    hold(page, "places")
    page.evaluate("window.monitoringTest.tick()")
    finish(page, pending(page, "places"))
    expect(chart).to_contain_text("5 of 7 places have a recorded time")
    assert page.evaluate("window.monitoringTest.state.requests.filter(r => r.kind === 'place-times').length") == before


def test_place_time_chart_error_does_not_hide_places_and_can_retry(page):
    seed_place_times(page)
    hold(page, "place-times")
    show(page, "places")
    request_id = pending(page, "place-times")
    chart = page.get_by_role("region", name="Inspection time by place")
    expect(chart).to_contain_text("Loading inspection times")
    expect(page.get_by_role("button", name="Slow place", exact=True)).to_be_visible()
    finish(page, request_id, "Timing unavailable")
    expect(chart).to_contain_text("Unable to load inspection times")
    expect(page.locator("#global-error")).to_contain_text("Inspection time chart is unavailable")
    expect(page.get_by_role("button", name="Slow place", exact=True)).to_be_visible()
    chart.get_by_role("button", name="Retry chart").click()
    expect(chart).to_contain_text("4 of 7 places have a recorded time")
    expect(page.locator("#global-error")).to_be_empty()
    expect(page.locator("#place-time-title")).to_be_focused()


def test_place_time_chart_ignores_old_filters_and_shares_inflight_read(page):
    seed_place_times(page)
    hold(page, "place-times")
    show(page, "places")
    request_id = pending(page, "place-times")
    page.locator("#place-query").fill("Slow place")
    page.locator("#place-search").click()
    expect(page.locator("#places-page")).to_contain_text("Page 1 of 1")
    finish(page, request_id)
    chart = page.get_by_role("region", name="Inspection time by place")
    expect(chart).to_contain_text("1 of 1 place has a recorded time")
    expect(chart.locator(".place-time-item")).to_have_count(1)
    expect(chart).to_contain_text("Slow place")
    expect(chart).not_to_contain_text("Quick place")
    assert page.evaluate("window.monitoringTest.state.requests.filter(r => r.kind === 'place-times').length") == 1


def test_place_time_chart_paging_scroll_and_focus(page):
    page.set_viewport_size({"width": 375, "height": 900})
    page.evaluate("""() => {
      const state = window.monitoringTest.state;
      const id = index => '00000000-0000-4000-8000-' + String(index + 1).padStart(12, '0');
      state.places = Array.from({length: 51}, (_, index) => ({
        worker_id: state.workerA, osm_id: 'node/' + String(index).padStart(3, '0'),
        source_record: {name: 'Timed place ' + String(index).padStart(3, '0')},
        latest_attempt_id: id(index), outcome: 'found', queue_status: 'checked', review_flag: false,
      }));
      state.attempts = state.places.map((place, index) => ({
        worker_id: place.worker_id, osm_id: place.osm_id, attempt_id: place.latest_attempt_id,
        worker_started_at: '2026-11-03T00:00:00.000Z',
        worker_completed_at: new Date(Date.parse('2026-11-03T00:00:00.000Z') + (index + 1) * 1000).toISOString(),
      }));
    }""")
    show(page, "places")
    chart = page.get_by_role("region", name="Inspection time by place")
    expect(chart).to_contain_text("50 of 50 places have a recorded time")
    expect(chart.locator(".place-time-item")).to_have_count(50)
    times = chart.get_by_role("list", name="Inspection times, longest first")
    times.focus()
    times.evaluate("node => { node.scrollTop = 100; }")
    assert times.evaluate("node => node.scrollTop") > 0
    before = page.evaluate("window.monitoringTest.state.requests.filter(r => r.kind === 'place-times').length")
    hold(page, "places")
    page.evaluate("window.monitoringTest.tick()")
    finish(page, pending(page, "places"))
    expect(times).to_be_focused()
    assert times.evaluate("node => node.scrollTop") > 0
    assert page.evaluate("window.monitoringTest.state.requests.filter(r => r.kind === 'place-times').length") == before
    page.locator("#places-next").click()
    expect(chart).to_contain_text("1 of 1 place has a recorded time")
    expect(chart).to_contain_text("Timed place 050")
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")


def test_place_time_chart_handles_long_names_and_large_text(page):
    seed_place_times(page)
    page.set_viewport_size({"width": 360, "height": 900})
    page.evaluate("""() => {
      document.documentElement.style.fontSize = '200%';
      window.monitoringTest.state.places[1].source_record.name = 'Place-' + 'P'.repeat(200);
    }""")
    show(page, "places")
    chart = page.get_by_role("region", name="Inspection time by place")
    expect(chart.locator(".place-time-label").first).to_contain_text("Place-")
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
