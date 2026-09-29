/* ============================================================
   KANBO — pre-paint theme. Loaded from index.html as a same-origin
   classic script (the CSP's script-src 'self' blocks inline scripts),
   so a saved Light preference never flashes dark before React mounts —
   including on /privacy and /terms, which never mount the app.
   It also keeps <meta name="theme-color"> (the mobile status bar and
   browser chrome) in step with the theme, including later in-app toggles.
   ============================================================ */
(function () {
  var root = document.documentElement;
  var CHROME = { light: "#f5f6f9", dark: "#1b1d24" };
  var mq = null;
  try { mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null; } catch (e) { /* ignore */ }

  function saved() {
    try { return localStorage.getItem("kanbo-theme"); } catch (e) { return null; }
  }
  function resolve(pref) {
    if (pref === "light" || pref === "dark") return pref;
    if (pref === "system" && mq) return mq.matches ? "dark" : "light";
    return "dark"; // on-brand default; matches the app's own default
  }
  function paintChrome() {
    var colour = CHROME[root.getAttribute("data-theme") === "light" ? "light" : "dark"];
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) metas[i].setAttribute("content", colour);
  }

  root.setAttribute("data-theme", resolve(saved()));
  paintChrome();

  // the app flips data-theme when the user toggles it — follow along
  if (typeof MutationObserver === "function") {
    new MutationObserver(paintChrome).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  }
  // "system" follows the OS live (re-read, in case the app has since saved an explicit choice)
  if (mq) {
    var follow = function () { if (saved() === "system") root.setAttribute("data-theme", resolve("system")); };
    if (mq.addEventListener) mq.addEventListener("change", follow);
    else if (mq.addListener) mq.addListener(follow);
  }
})();
