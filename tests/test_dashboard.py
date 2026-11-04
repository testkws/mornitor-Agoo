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
      state.workers[1].last_heartbeat_at = new Date(now - 400000).toISOString();
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

    page.locator("#active-worker").select_option(page.evaluate("window.monitoringTest.state.workerA"))
    expect(metric(page, "success").locator(".summary-value")).to_have_text("37.5%")
    expect(metric(page, "retry").locator(".summary-value")).to_have_text("12.5%")
    expect(metric(page, "success")).to_contain_text("3 of 8 attempts")
    page.locator("#active-worker").select_option(page.evaluate("window.monitoringTest.state.workerB"))
    expect(metric(page, "success").locator(".summary-value")).to_have_text("100.0%")
    expect(metric(page, "retry").locator(".summary-value")).to_have_text("0.0%")
    expect(metric(page, "blocked").locator(".summary-value")).to_have_text("0")
    expect(metric(page, "queue").locator(".summary-value")).to_have_text("0")


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
    page.locator("#refresh").click()
    expect(metric(page, "success").locator(".summary-value")).to_have_text("100.0%")
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
    expect(page.locator("#global-error")).to_be_empty()


def test_summary_uses_head_counts_without_page_limit(page):
    page.evaluate("""() => {
      const state = window.monitoringTest.state;
      state.attempts = Array.from({length: 1250}, (_, index) => ({
        worker_id: state.workerA, attempt_id: String(index), outcome: 'found', status: 'checked',
        worker_completed_at: new Date(Date.now() - 1000).toISOString()
      }));
    }""")
    page.locator("#refresh").click()
    expect(metric(page, "success")).to_contain_text("1,250 of 1,250 attempts")
    requests = page.evaluate("window.monitoringTest.state.requests.filter(r => r.kind.startsWith('metric-')).slice(-5)")
    assert len(requests) == 5
    assert all(request["params"]["head"] for request in requests)
    assert requests[-1]["kind"] == "metric-total"


@pytest.mark.parametrize("width", [320, 375, 1024, 1440])
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
    page.close()


def test_theme_palette_has_readable_text_and_touch_targets(page):
    def luminance(value):
        channels = [int(value[index:index + 2], 16) / 255 for index in (1, 3, 5)]
        linear = [channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4 for channel in channels]
        return sum(channel * weight for channel, weight in zip(linear, (0.2126, 0.7152, 0.0722)))

    pairs = [("--ink", "--bg"), ("--ink", "--surface"), ("--muted", "--surface-2"),
             ("--accent", "--bg"), ("--accent", "--accent-soft"), ("--warn", "--warn-soft"),
             ("--bad", "--bad-soft"), ("--info", "--info-soft"), ("--accent-ink", "--action"),
             ("--accent-ink", "--action-hover")]
    for theme in ("light", "dark"):
        page.evaluate("theme => { document.documentElement.dataset.theme = theme; }", theme)
        colors = page.evaluate("""() => {
          const styles = getComputedStyle(document.documentElement);
          return Object.fromEntries(['--bg', '--ink', '--surface', '--muted', '--surface-2', '--accent', '--accent-soft',
            '--warn', '--warn-soft', '--bad', '--bad-soft', '--info', '--info-soft', '--accent-ink', '--action',
            '--action-hover']
            .map(name => [name, styles.getPropertyValue(name).trim().toLowerCase()]));
        }""")
        for foreground, background in pairs:
            low, high = sorted((luminance(colors[foreground]), luminance(colors[background])))
            assert (high + 0.05) / (low + 0.05) >= 4.5, (theme, foreground, background)

    page.evaluate("document.documentElement.dataset.theme = 'light'")
    rendered = page.evaluate("""() => ({
      background: getComputedStyle(document.body).backgroundColor,
      logo: getComputedStyle(document.querySelector('.logo')).backgroundColor,
      card: getComputedStyle(document.querySelector('.summary-card')).backgroundColor,
      cardBorder: getComputedStyle(document.querySelector('.summary-card')).borderTopColor,
      action: getComputedStyle(document.querySelector('#place-search')).backgroundColor,
      navigation: getComputedStyle(document.querySelector('.tab.active'), '::after').backgroundColor,
    })""")
    assert rendered == {
        "background": "rgb(255, 255, 255)",
        "logo": "rgb(0, 128, 128)",
        "card": "rgb(255, 255, 255)",
        "cardBorder": "rgb(224, 224, 224)",
        "action": "rgb(0, 128, 128)",
        "navigation": "rgb(0, 109, 109)",
    }
    show(page, "places")
    page.locator("#place-search").hover()
    expect(page.locator("#place-search")).to_have_css("background-color", "rgb(0, 109, 109)")
    expect(page.locator("#place-search")).to_have_css("color", "rgb(255, 255, 255)")

    page.emulate_media(color_scheme="dark")
    page.evaluate("delete document.documentElement.dataset.theme")
    system_dark = page.evaluate("getComputedStyle(document.body).backgroundColor")
    page.evaluate("document.documentElement.dataset.theme = 'dark'")
    assert page.evaluate("getComputedStyle(document.body).backgroundColor") == system_dark
    assert system_dark != rendered["background"]

    page.set_viewport_size({"width": 375, "height": 900})
    for selector in ("#theme-toggle", "#refresh", "#active-worker"):
        box = page.locator(selector).bounding_box()
        assert box["width"] >= 44 and box["height"] >= 44, selector


def test_dashboard_navigation_is_keyboard_accessible(page):
    overview = page.locator('button[data-view="overview"]')
    places = page.locator('button[data-view="places"]')
    overview.focus()
    page.keyboard.press("Tab")
    expect(places).to_be_focused()
    page.keyboard.press("Enter")
    expect(page.locator("#places-view")).to_be_visible()
    expect(places).to_have_attribute("aria-pressed", "true")
    expect(overview).to_have_attribute("aria-pressed", "false")


def test_mobile_tables_and_place_dialog_are_accessible(page):
    page.set_viewport_size({"width": 375, "height": 900})
    show(page, "places")
    region = page.get_by_role("region", name="Places table")
    expect(region).to_have_attribute("tabindex", "0")
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
    page.locator("#place-search").click()
    expect(page.locator("#global-error")).to_be_empty()


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
    show(page, "places")
    page.get_by_role("button", name="Place 000", exact=True).click()
    expect(page.locator("#attempts-page")).to_contain_text("Page 1 of 3")
    page.locator("#attempts-next").click()
    expect(page.get_by_text("Attempt 050", exact=True)).to_be_visible()
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
    expect(page.locator("#detail-content")).to_contain_text("Close and reopen to retry")
    expect(page.locator("#attempts-page")).to_have_text("Unavailable")


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
