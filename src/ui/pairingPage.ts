/**
 * Pairing form. The code is typed here and sent in a request body, never placed in
 * a URL, so it cannot reach browser history, logs or a Referer header.
 */
export function renderPairingPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <title>Pair this browser</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
    input, button { font: inherit; padding: 0.4rem 0.6rem; }
    input { letter-spacing: 0.1em; text-transform: uppercase; }
    #pairStatus { min-height: 1.5em; }
  </style>
</head>
<body>
  <h1>Pair this browser</h1>
  <p>Enter the pairing code shown in the server's console. A code works once and
  expires after ten minutes.</p>
  <!-- POST, and the input has no name: even if this script fails, a native submit
       sends no code, and nothing is ever placed in the URL. -->
  <form id="pairForm" method="post" action="/pair" autocomplete="off">
    <label for="pairCode">Pairing code</label>
    <input id="pairCode" maxlength="11" placeholder="XXXXX-XXXXX" required />
    <button type="submit">Pair</button>
  </form>
  <p id="pairStatus" role="status"></p>
  <script>
    const messages = {
      PAIRING_FAILED: "That code is not valid. Check the console and try again.",
      PAIRING_NOT_ACTIVE: "No code is active. Ask the operator for a new one, or restart the server.",
      PAIRING_DISABLED: "Pairing is not enabled on this server."
    };
    document.getElementById("pairForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const status = document.getElementById("pairStatus");
      const input = document.getElementById("pairCode");
      const code = String(input.value || "").trim().toUpperCase();
      input.value = "";
      status.textContent = "Pairing…";
      try {
        const res = await fetch("/pair", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code })
        });
        if (res.ok) { location.replace("/"); return; }
        const body = await res.json().catch(() => ({}));
        status.textContent = messages[body.code] || "Pairing failed.";
      } catch {
        status.textContent = "The server could not be reached.";
      }
    });
  </script>
</body>
</html>`;
}
