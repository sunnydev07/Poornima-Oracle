"""Manual mobile accessibility smoke test against a local static server.

The Playwright route blocks every request except the local static server, so
this smoke test cannot call the production Gemini or Pinecone APIs.
"""

import os
import urllib.request
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

BASE_URL = os.environ.get("POORNIMA_SMOKE_BASE_URL", "http://127.0.0.1:3001").rstrip("/")
BASE_HOST = urlparse(BASE_URL).hostname
if urlparse(BASE_URL).scheme != "http" or BASE_HOST not in {"127.0.0.1", "localhost", "::1"}:
    raise ValueError("POORNIMA_SMOKE_BASE_URL must point to a local loopback HTTP server.")


def main():
    with urllib.request.urlopen(f"{BASE_URL}/index.html", timeout=5) as response:
        assert response.status == 200

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(
            viewport={"width": 390, "height": 844},
            is_mobile=True,
            has_touch=True,
            reduced_motion="reduce",
        )
        page_errors = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))

        def allow_local_server_only(route):
            if route.request.url.startswith(f"{BASE_URL}/"):
                route.continue_()
            else:
                route.abort()

        page.route("**/*", allow_local_server_only)
        page.add_init_script("localStorage.setItem('poornimaOracleDemoMode', 'true')")
        page.goto(f"{BASE_URL}/index.html", wait_until="load", timeout=30000)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(250)

        viewport = page.locator('meta[name="viewport"]').get_attribute("content")
        assert "user-scalable=no" not in viewport and "maximum-scale=1" not in viewport
        assert page.get_by_role("textbox", name="Message").count() == 1
        assert page.locator("#chatStatus").get_attribute("aria-live") == "polite"
        assert page.locator("#click-spark-canvas").get_attribute("aria-hidden") == "true"
        assert page.locator("#click-spark-canvas").evaluate(
            "element => getComputedStyle(element).display"
        ) == "none"

        unnamed_buttons = page.locator("button").evaluate_all(
            """buttons => buttons.filter(button => {
                const style = getComputedStyle(button);
                const visible = style.display !== 'none' && style.visibility !== 'hidden'
                    && button.getClientRects().length > 0;
                return visible && !button.getAttribute('aria-label') && !button.title
                    && !button.innerText.trim();
            }).map(button => button.outerHTML.slice(0, 160))"""
        )
        assert not unnamed_buttons, unnamed_buttons

        menu_button = page.get_by_role("button", name="Open conversation history")
        menu_button.click()
        menu = page.locator('[aria-label="Open conversation history"]')
        close_drawer = page.get_by_role("button", name="Close conversation history")
        assert menu.get_attribute("aria-expanded") == "true"
        assert page.locator("#sidebar").evaluate("element => element.inert") is False
        assert page.locator("#mainChat").evaluate("element => element.inert") is True
        assert page.get_by_role("button", name="Start a new chat").is_visible()
        close_drawer.focus()
        page.keyboard.press("Shift+Tab")
        assert page.evaluate("document.activeElement.getAttribute('aria-label')") == "Start a new chat"
        page.keyboard.press("Tab")
        assert page.evaluate("document.activeElement.getAttribute('aria-label')") == "Close conversation history"
        page.keyboard.press("Escape")
        assert menu.get_attribute("aria-expanded") == "false"
        assert page.locator("#sidebar").evaluate("element => element.inert") is True
        assert page.locator("#mainChat").evaluate("element => element.inert") is False
        assert page.evaluate(
            "document.activeElement === document.querySelector('[aria-label=\"Open conversation history\"]')"
        )

        menu.click()
        page.get_by_role("button", name="Close conversation history").click()
        assert menu.get_attribute("aria-expanded") == "false"

        settings = page.get_by_role("button", name="Open API settings")
        settings.click()
        dialog = page.get_by_role("dialog", name="Setup API")
        assert dialog.is_visible()
        assert page.locator("#mainChat").evaluate("element => element.inert") is True
        assert page.locator("#sidebar").evaluate("element => element.inert") is True
        assert page.get_by_label("Backend API endpoint").count() == 1
        page.wait_for_function("document.activeElement.id === 'apiEndpoint'")
        page.get_by_role("button", name="Save").focus()
        page.keyboard.press("Tab")
        assert page.evaluate("document.activeElement.getAttribute('aria-label')") == "Close API settings"
        page.keyboard.press("Escape")
        assert not dialog.is_visible()
        assert page.locator("#mainChat").evaluate("element => element.inert") is False
        assert page.locator("#sidebar").evaluate("element => element.inert") is True
        assert page.evaluate(
            "document.activeElement === document.querySelector('[aria-label=\"Open API settings\"]')"
        )

        page.get_by_role("textbox", name="Message").fill("Offline accessibility smoke test")
        page.get_by_role("button", name="Send message").click()
        page.wait_for_function(
            "document.querySelector('#chatStatus').textContent === 'Response complete. The answer is in the conversation.'",
            timeout=10000,
        )
        assert page.locator("#chatContainer").get_attribute("aria-busy") == "false"
        assert not page_errors, page_errors

        print("PASS: isolated mobile accessibility smoke checks; external requests blocked; no page errors")
        browser.close()


if __name__ == "__main__":
    main()
