/*
 * Digimetrics automated error reporter (shared across index.html, chatbot.html,
 * scheduler.html, campaign-board-crawler.html).
 *
 * Sends bug/error reports to the team Google Chat space via the `report_error`
 * action on the monday API Gateway (the webhook itself is held server-side in the
 * Lambda env, never exposed here).
 *
 * Usage from page code at an API-failure point:
 *   window.DMError && DMError.report({
 *     function: 'claude_chat_with_tools',     // the function the user tried to run
 *     inputs:   { prompt: userText },          // their inputs (object or string)
 *     error:    errObjOrMessage,               // Error object or string
 *     apiResponse: rawApiJson                  // the return from the API (object or string)
 *   });
 *
 * Uncaught errors (window.onerror) and unhandled promise rejections are captured
 * automatically — no per-call wiring needed for those.
 */
(function () {
    'use strict';
    if (window.DMError) return; // already installed

    var ENDPOINT = 'https://1rxrp7gth2.execute-api.ap-southeast-1.amazonaws.com/monday';
    var APP = (location.pathname.split('/').pop() || 'index.html') || 'index.html';
    var SECRET_RE = /token|key|secret|authorization|password|cookie|bearer|api[_-]?key/i;
    var _recent = {}; // signature -> ts, client-side throttle (mirrors the server dedup)

    function getUser() {
        try {
            return localStorage.getItem('clientEmail')
                || localStorage.getItem('userEmail')
                || localStorage.getItem('client_email')
                || (function () {
                    try { return (JSON.parse(localStorage.getItem('currentUser') || 'null') || {}).email; }
                    catch (e) { return null; }
                })()
                || (typeof getUserEmail === 'function' ? getUserEmail() : null)
                || 'anonymous';
        } catch (e) { return 'anonymous'; }
    }

    function redact(key, val) {
        if (typeof key === 'string' && SECRET_RE.test(key)) return '[redacted]';
        return val;
    }

    function asText(v, max) {
        max = max || 4000;
        try {
            if (v == null) return '';
            var s;
            if (typeof v === 'string') s = v;
            else if (v instanceof Error) s = v.message || String(v);
            else s = JSON.stringify(v, redact, 2);
            if (s == null) s = String(v);
            return s.length > max ? s.slice(0, max) + ' …[truncated]' : s;
        } catch (e) { try { return String(v); } catch (e2) { return ''; } }
    }

    function throttle(sig) {
        var now = Date.now();
        for (var k in _recent) { if (now - _recent[k] > 60000) delete _recent[k]; }
        if (_recent[sig] && now - _recent[sig] < 60000) return false;
        _recent[sig] = now;
        return true;
    }

    function report(ctx) {
        try {
            ctx = ctx || {};
            var err = ctx.error;
            var payload = {
                action: 'report_error',
                app: APP,
                user: getUser(),
                function: ctx.function || ctx.fn || 'unknown',
                inputs: asText(ctx.inputs, 3000),
                error: asText(err instanceof Error ? err.message : err, 2000),
                stack: (err && err.stack) ? String(err.stack).slice(0, 1500) : '',
                apiResponse: asText(ctx.apiResponse, 3000),
                datetime: new Date().toISOString(),
                url: location.href,
                userAgent: navigator.userAgent
            };
            var sig = payload.app + '|' + payload.function + '|' + payload.error;
            if (!throttle(sig)) return;
            fetch(ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                keepalive: true
            }).catch(function () { /* never surface reporter failures */ });
        } catch (e) { /* the reporter must never throw */ }
    }

    window.DMError = { report: report };

    // ── Global safety nets ────────────────────────────────────────────────
    window.addEventListener('error', function (ev) {
        if (!ev || !ev.message) return;           // ignore resource-load errors (no message)
        report({
            function: 'window.onerror',
            error: ev.error || ev.message,
            inputs: { source: ev.filename, line: ev.lineno, col: ev.colno }
        });
    });
    window.addEventListener('unhandledrejection', function (ev) {
        var reason = ev && ev.reason;
        if (!reason) return;
        report({ function: 'unhandledrejection', error: reason });
    });
})();
