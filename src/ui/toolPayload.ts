import type { ToolResult } from "../app/toolResult";
/** Embedded in the browser. Provider strings are rendered as text, never HTML. */
export function renderToolPayloads(container: HTMLElement, results: ToolResult[]) {
  container.replaceChildren();
  for (const result of results) {
    if (!result.payload) continue;
    const table = document.createElement("table");
    const caption = table.createCaption(); caption.textContent = result.payload.title;
    const header = table.createTHead().insertRow();
    for (const column of result.payload.columns) {
      const cell = document.createElement("th"); cell.scope = "col"; cell.textContent = column; header.appendChild(cell);
    }
    const body = table.createTBody();
    for (const row of result.payload.rows) {
      const element = body.insertRow();
      for (const value of row) element.insertCell().textContent = value;
    }
    container.appendChild(table);
    const info = document.createElement("p");
    info.textContent = result.context.scope + ". " + result.context.limitations.join(". ") + ". Observed: " + result.evidence.observedAt;
    container.appendChild(info);
    const source = document.createElement("a");
    if (["https:", "http:"].includes(new URL(result.evidence.sourceUrl).protocol)) {
      source.href = result.evidence.sourceUrl; source.textContent = "Source"; source.rel = "noreferrer"; container.appendChild(source);
    }
  }
}
