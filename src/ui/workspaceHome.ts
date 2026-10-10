/** The approved workspace shell composes the existing controllers and their single DOM instances. */
export function renderWorkspaceHomePageHtml(legacyHtml: string): string {
  const main = legacyHtml.match(/<main\b[^>]*>[\s\S]*?<\/main>/i)?.[0];
  if (!main) throw new Error("Workspace composition requires the existing main controls.");
  const styles = [...legacyHtml.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((match) => scopeLegacyCss(match[1]))
    .join("\n");
  const scripts = [...legacyHtml.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)]
    .map((match) => match[0])
    .join("\n");
  const controls = main.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  return WORKSPACE_DOCUMENT.replace("<style>", "<style>" + styles + "</style><style>").replace(
    "<script>",
    '<div id="workspaceLegacyControls" class="legacy-controls-scope" hidden>' +
      controls +
      "</div>" +
      scripts +
      "<script>"
  );
}

/** Legacy selectors are scoped to the moved controls; shell geometry and colors remain independent. */
function scopeLegacyCss(css: string): string {
  let result = "",
    cursor = 0;
  while (cursor < css.length) {
    const open = css.indexOf("{", cursor);
    if (open < 0) {
      result += css.slice(cursor);
      break;
    }
    const header = css.slice(cursor, open).trim();
    let depth = 1,
      end = open + 1;
    while (end < css.length && depth) {
      if (css[end] === "{") depth++;
      else if (css[end] === "}") depth--;
      end++;
    }
    const body = css.slice(open + 1, end - 1);
    if (/^@(?:media|supports|container|layer)\b/.test(header))
      result += header + "{" + scopeLegacyCss(body) + "}";
    else if (header.startsWith("@")) result += header + "{" + body + "}";
    else {
      const selectors = header
        .split(",")
        .map((selector) => selector.trim())
        .filter((selector) => selector !== "body" && selector !== "html")
        .map((selector) =>
          selector === ":root" ? ".legacy-controls-scope" : ".legacy-controls-scope " + selector
        );
      if (selectors.length) result += selectors.join(",") + "{" + body + "}";
    }
    cursor = end;
  }
  return result;
}

const WORKSPACE_DOCUMENT = String.raw`
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Workspace | ChatAgent</title>
    <style>
      :root {
        --canvas: #f5f7fb;
        --surface: #fff;
        --ink: #202b3c;
        --muted: #667387;
        --line: #e5eaf2;
        --blue: #335eea;
        --blue-soft: #edf2ff;
        --amber: #9a6414;
        --amber-soft: #fff6e5;
        --green: #18785c;
        --green-soft: #eaf7f0;
        --radius: 14px;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        background: var(--canvas);
        color: var(--ink);
        font-family: Inter, "Segoe UI", Arial, sans-serif;
        font-size: 14px;
        line-height: 1.5;
      }
      button,
      input,
      textarea,
      select {
        font: inherit;
      }
      button {
        cursor: pointer;
      }
      button:focus-visible,
      a:focus-visible,
      input:focus-visible,
      textarea:focus-visible,
      select:focus-visible {
        outline: 3px solid #9eb4ff;
        outline-offset: 3px;
      }
      button {
        border: 0;
      }
      svg {
        width: 20px;
        height: 20px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.7;
        stroke-linecap: round;
        stroke-linejoin: round;
        flex-shrink: 0;
      }
      .app {
        display: grid;
        grid-template-columns: 218px minmax(0, 1fr);
        min-height: 100vh;
      }
      .sidebar {
        background: var(--surface);
        border-right: 1px solid var(--line);
        padding: 29px 18px;
        display: flex;
        flex-direction: column;
        gap: 30px;
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 20px;
        font-weight: 700;
        letter-spacing: -0.7px;
        padding: 0 10px;
      }
      .brand-mark {
        display: grid;
        place-items: center;
        color: #fff;
        background: var(--blue);
        width: 32px;
        height: 32px;
        border-radius: 10px;
        box-shadow: 0 4px 12px #335eea20;
      }
      .brand-mark svg {
        width: 21px;
        height: 21px;
        stroke-width: 2;
      }
      .eyebrow {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: #8490a2;
      }
      .sidebar .eyebrow {
        padding: 0 12px;
        margin: 0 0 10px;
      }
      .project-nav {
        display: grid;
        gap: 5px;
      }
      .nav-button {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 11px 12px;
        border-radius: 9px;
        width: 100%;
        text-align: left;
        color: #647187;
        background: transparent;
      }
      .nav-button.selected {
        background: var(--blue-soft);
        color: var(--blue);
        font-weight: 600;
      }
      .nav-button .count {
        margin-left: auto;
        font-size: 12px;
        color: #929dad;
      }
      .nav-button.selected .count {
        color: var(--blue);
      }
      .project-dot {
        width: 9px;
        height: 9px;
        border-radius: 3px;
        background: #6585f0;
        margin: 4px;
      }
      .project-dot.purple {
        background: #9880d6;
      }
      .project-dot.teal {
        background: #5ba99d;
      }
      .sidebar-bottom {
        margin-top: auto;
        display: grid;
        gap: 14px;
        padding: 8px 10px;
      }
      .preview-tag {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        font-size: 11px;
        color: #6e7b90;
        background: #f4f6fa;
        border: 1px solid var(--line);
        padding: 6px 9px;
        border-radius: 7px;
        white-space: nowrap;
      }
      .preview-tag .dot {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: #8091ab;
      }
      .sidebar-note {
        font-size: 12px;
        color: #8290a3;
        margin: 0;
      }
      .avatar {
        display: grid;
        place-items: center;
        width: 32px;
        height: 32px;
        background: #eaf0f8;
        border-radius: 50%;
        color: #61718b;
        font-size: 12px;
        font-weight: 600;
      }
      .account {
        display: flex;
        gap: 10px;
        align-items: center;
        border-top: 1px solid var(--line);
        padding-top: 18px;
      }
      .account small {
        display: block;
        color: var(--muted);
        font-size: 11px;
      }
      .main {
        min-width: 0;
      }
      .topbar {
        height: 78px;
        background: var(--surface);
        border-bottom: 1px solid var(--line);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 24px;
        padding: 0 32px;
      }
      .breadcrumb {
        display: flex;
        align-items: center;
        gap: 12px;
        color: #929cad;
        font-size: 13px;
      }
      .breadcrumb strong {
        color: var(--ink);
        font-weight: 600;
      }
      .top-right {
        display: flex;
        align-items: center;
        gap: 15px;
      }
      .search {
        position: relative;
        width: 280px;
      }
      .search svg {
        position: absolute;
        left: 12px;
        top: 11px;
        width: 17px;
        height: 17px;
        color: #8c98aa;
      }
      .search input {
        background: #f7f9fc;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 10px 34px;
        width: 100%;
        font-size: 12px;
        color: var(--ink);
      }
      .shortcut {
        position: absolute;
        right: 11px;
        top: 11px;
        color: #9ba6b6;
        font-size: 11px;
      }
      .button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        font-weight: 600;
        padding: 10px 15px;
        border-radius: 8px;
        font-size: 12px;
        color: #4c5b72;
        background: #fff;
        border: 1px solid #dfe5ef;
      }
      .button svg {
        width: 16px;
        height: 16px;
      }
      .button.primary {
        color: #fff;
        background: var(--blue);
        border-color: var(--blue);
        box-shadow: 0 3px 7px #335eea14;
      }
      .button:hover {
        filter: brightness(0.97);
      }
      .button.subtle {
        background: transparent;
        border-color: transparent;
      }
      .content {
        padding: 29px 32px;
        max-width: 1520px;
        margin: 0 auto;
      }
      .page-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 22px;
      }
      h1 {
        font-size: 26px;
        letter-spacing: -0.7px;
        line-height: 1.2;
        margin: 0 0 8px;
        font-weight: 650;
      }
      .page-heading p {
        color: var(--muted);
        font-size: 13px;
        margin: 0;
      }
      .live-label {
        display: flex;
        align-items: center;
        gap: 6px;
        color: #8591a2;
        font-size: 11px;
      }
      .live-label span {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #91a1b8;
      }
      .tabs {
        display: flex;
        border-bottom: 1px solid var(--line);
        margin-bottom: 23px;
        gap: 26px;
      }
      .tab {
        position: relative;
        display: flex;
        align-items: center;
        gap: 8px;
        color: #7c889b;
        background: transparent;
        padding: 0 1px 13px;
        font-size: 13px;
        font-weight: 600;
      }
      .tab svg {
        width: 17px;
        height: 17px;
      }
      .tab.active {
        color: var(--blue);
      }
      .tab.active:after {
        content: "";
        position: absolute;
        height: 2px;
        bottom: -1px;
        width: 100%;
        background: var(--blue);
        border-radius: 2px;
      }
      .tab .tab-count {
        color: #8794a8;
        background: #eef1f6;
        border-radius: 5px;
        padding: 0 5px;
        font-size: 10px;
      }
      .summary-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        gap: 13px;
        margin-bottom: 24px;
      }
      .summary {
        text-align: left;
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: 11px;
        padding: 15px 18px;
        display: flex;
        align-items: center;
        gap: 13px;
      }
      .summary-icon {
        display: grid;
        place-items: center;
        width: 36px;
        height: 36px;
        border-radius: 10px;
        background: #f0f4fd;
        color: #6382ca;
      }
      .summary.needs .summary-icon {
        background: var(--amber-soft);
        color: #bd8a38;
      }
      .summary.ready .summary-icon {
        background: #eef7f2;
        color: #509175;
      }
      .summary.selected {
        border-color: #94acf8;
        background: #fafcff;
      }
      .summary strong {
        font-size: 23px;
        font-weight: 650;
        line-height: 1;
      }
      .summary span {
        display: block;
        color: var(--muted);
        font-size: 11px;
        margin-top: 4px;
      }
      .workspace-grid {
        display: grid;
        grid-template-columns: minmax(310px, 0.94fr) minmax(400px, 1.06fr);
        gap: 22px;
        align-items: start;
      }
      .card {
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: var(--radius);
        min-width: 0;
      }
      .list-heading {
        padding: 19px 19px 16px;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      h2 {
        font-size: 15px;
        font-weight: 650;
        margin: 0;
        letter-spacing: -0.2px;
      }
      .list-heading small {
        color: #8a96a8;
        font-size: 11px;
      }
      .list-filters {
        padding: 0 18px 16px;
        display: flex;
        gap: 7px;
        flex-wrap: wrap;
      }
      .filter {
        background: #f7f9fc;
        border: 1px solid transparent;
        border-radius: 6px;
        font-size: 11px;
        color: #7b879a;
        padding: 5px 10px;
      }
      .filter.selected {
        background: var(--blue-soft);
        color: var(--blue);
        border-color: #e0e8ff;
        font-weight: 600;
      }
      .work-list {
        position: relative;
        max-height: 474px;
        overflow: auto;
      }
      .work-row {
        position: relative;
        width: 100%;
        text-align: left;
        display: flex;
        gap: 11px;
        background: #fff;
        padding: 18px 19px;
        border-top: 1px solid #eef1f6;
        color: var(--ink);
      }
      .work-row.selected {
        background: #f5f8ff;
      }
      .work-row.selected:before {
        position: absolute;
        content: "";
        left: 0;
        top: 15px;
        bottom: 15px;
        width: 3px;
        background: var(--blue);
        border-radius: 0 3px 3px 0;
      }
      .work-row:hover {
        background: #f8faff;
      }
      .work-icon {
        background: #f5f7fb;
        color: #8a9bb4;
        width: 32px;
        height: 32px;
        border-radius: 9px;
        display: grid;
        place-items: center;
        flex-shrink: 0;
        margin-top: 2px;
      }
      .work-icon svg {
        width: 17px;
        height: 17px;
      }
      .work-row.selected .work-icon {
        background: #e8efff;
        color: #6380d1;
      }
      .row-body {
        min-width: 0;
        flex: 1;
      }
      .row-title {
        display: block;
        font-size: 12px;
        font-weight: 650;
        margin-bottom: 6px;
      }
      .row-description {
        color: #5f6e84;
        font-size: 11px;
        display: block;
        margin-bottom: 10px;
      }
      .row-allocation {
        display: block;
        margin: 0 0 8px;
        font-size: 11px;
        color: #5f6e84;
      }
      .row-meta {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .row-meta .project-label {
        font-size: 10px;
        color: #8995a7;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: 10px;
        font-weight: 600;
        color: #7a879b;
        background: #f0f3f8;
        padding: 3px 7px;
        border-radius: 5px;
        white-space: normal;
        max-width: 100%;
      }
      .badge:before {
        content: "";
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: currentColor;
      }
      .badge.needs {
        color: var(--amber);
        background: var(--amber-soft);
      }
      .badge.running,
      .badge.in_progress {
        color: #4879c8;
        background: #edf4ff;
      }
      .badge.ready {
        color: #697b92;
        background: #f0f3f8;
      }
      .badge.completed {
        color: var(--green);
        background: var(--green-soft);
      }
      .row-arrow {
        align-self: center;
        width: 14px;
        height: 14px;
        color: #bac3d1;
      }
      .list-footer {
        padding: 13px 19px;
        border-top: 1px solid var(--line);
        display: flex;
        align-items: center;
        justify-content: space-between;
        color: #99a4b5;
        font-size: 10px;
      }
      .list-footer button {
        background: none;
        color: #7385a4;
        font-size: 10px;
      }
      #detail {
        display: flex;
        flex-direction: column;
        max-height: calc(100vh - 396px);
        min-height: 520px;
      }
      #detail .detail-head,
      #detail .detail-tabs,
      #detail .detail-footer {
        flex-shrink: 0;
      }
      #detail .detail-content {
        min-height: 0;
        overflow: auto;
      }
      .detail-head {
        padding: 22px 23px 19px;
        border-bottom: 1px solid var(--line);
      }
      .detail-meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 13px;
      }
      .detail-project {
        font-size: 10px;
        color: #8995a7;
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .detail-project svg {
        width: 13px;
        height: 13px;
      }
      .detail-head h2 {
        font-size: 19px;
        font-weight: 650;
        letter-spacing: -0.4px;
        margin-bottom: 7px;
      }
      .goal {
        color: var(--muted);
        font-size: 12px;
        margin: 0;
        line-height: 1.7;
      }
      .detail-tabs {
        display: flex;
        gap: 22px;
        padding: 0 23px;
        margin: 0;
        border-bottom: 1px solid var(--line);
      }
      .detail-tabs .tab {
        font-size: 11px;
        padding-top: 13px;
        padding-bottom: 11px;
      }
      .detail-content {
        padding: 18px 23px 20px;
      }
      .section-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 12px;
      }
      h3 {
        font-size: 11px;
        color: #5b697f;
        margin: 0;
        font-weight: 600;
      }
      .section-heading small {
        font-size: 10px;
        color: #96a0af;
      }
      .step-list {
        display: grid;
        gap: 6px;
        margin-bottom: 18px;
      }
      .step {
        width: 100%;
        text-align: left;
        display: flex;
        align-items: center;
        gap: 11px;
        border: 1px solid transparent;
        padding: 10px 11px;
        border-radius: 8px;
        color: var(--ink);
        background: #fff;
      }
      .step.current {
        background: #fff9ee;
        border-color: #f6e9d3;
      }
      .step.chosen {
        outline: 1px solid #dbe5fa;
        background: #f8faff;
      }
      .step-marker {
        display: grid;
        place-items: center;
        width: 23px;
        height: 23px;
        border-radius: 50%;
        background: #f0f3f8;
        color: #8d9aae;
        font-size: 10px;
        flex-shrink: 0;
      }
      .step-marker.complete {
        background: var(--green-soft);
        color: #4e987a;
      }
      .step-marker.complete svg {
        width: 13px;
        height: 13px;
      }
      .step-marker.review {
        background: #ffebc4;
        color: #b88732;
      }
      .step-name {
        font-size: 11px;
        font-weight: 600;
        flex: 1;
      }
      .step-name small {
        display: block;
        font-size: 9px;
        color: #909cac;
        font-weight: 400;
        margin-top: 2px;
      }
      .step-right {
        font-size: 9px;
        color: #8c98aa;
      }
      .step.current .step-right {
        color: #a97827;
      }
      .result-card {
        border: 1px solid #e5eaf3;
        background: #fafbfd;
        border-radius: 9px;
        padding: 13px 14px;
        margin-bottom: 16px;
      }
      .result-title {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
        font-size: 11px;
        font-weight: 600;
      }
      .result-title span {
        font-size: 9px;
        color: #8e99ab;
        font-weight: 400;
      }
      .result-card p {
        color: #6a778b;
        font-size: 11px;
        line-height: 1.7;
        margin: 6px 0;
      }
      .result-card ul {
        padding-left: 15px;
        margin: 6px 0;
        font-size: 11px;
        color: #637087;
        line-height: 1.8;
      }
      .notice {
        display: flex;
        gap: 7px;
        border-radius: 6px;
        padding: 8px 9px;
        background: var(--amber-soft);
        color: #aa7a2f;
        font-size: 10px;
        margin-top: 9px;
      }
      .notice svg {
        width: 13px;
        height: 13px;
        margin-top: 1px;
      }
      .io-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 9px;
        margin-bottom: 14px;
      }
      .io {
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 9px 11px;
      }
      .io .eyebrow {
        font-size: 9px;
        letter-spacing: 0.07em;
        margin-bottom: 4px;
      }
      .io p {
        margin: 0;
        font-size: 10px;
        color: #6d7b90;
      }
      .context-line {
        display: flex;
        gap: 12px;
        font-size: 10px;
        color: #8995a8;
        flex-wrap: wrap;
        margin-bottom: 11px;
      }
      .context-line span {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .context-line svg {
        width: 12px;
        height: 12px;
      }
      .assignment {
        display: flex;
        align-items: center;
        gap: 7px;
        font-size: 10px;
        color: #8894a5;
        padding-top: 11px;
        border-top: 1px solid #eef1f6;
      }
      .assignment select {
        border: 1px solid var(--line);
        border-radius: 5px;
        color: #64728a;
        padding: 4px 7px;
        background: #fff;
        font-size: 10px;
      }
      details {
        font-size: 10px;
        color: #8d99aa;
        margin-top: 13px;
      }
      summary {
        cursor: pointer;
      }
      pre {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        max-height: 180px;
        overflow: auto;
        background: #f5f7fb;
        padding: 12px;
        border-radius: 6px;
        font-size: 10px;
        color: #68778e;
      }
      .detail-footer {
        padding: 15px 23px;
        border-top: 1px solid var(--line);
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }
      .detail-footer small {
        color: #939fb0;
        font-size: 10px;
      }
      .detail-footer .button {
        padding: 10px 15px;
      }
      .activity-list {
        padding: 0;
        margin: 0;
        list-style: none;
        display: grid;
        gap: 18px;
      }
      .activity-item {
        display: flex;
        gap: 11px;
      }
      .activity-point {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #aec0eb;
        flex-shrink: 0;
        margin-top: 6px;
      }
      .activity-item strong {
        display: block;
        font-size: 11px;
        font-weight: 600;
      }
      .activity-item p {
        font-size: 11px;
        color: #8190a5;
        margin: 4px 0;
      }
      .activity-item time {
        font-size: 9px;
        color: #a3adbb;
      }
      .demo-note {
        font-size: 10px;
        color: #97a2b3;
        margin: 15px 0 0;
      }
      [hidden] {
        display: none !important;
      }
      .empty {
        padding: 30px 20px;
        font-size: 12px;
        color: #8492a8;
      }
      .conversation-list {
        max-height: 526px;
        overflow: auto;
      }
      .conversation-row {
        display: block;
        text-align: left;
        width: 100%;
        padding: 20px;
        border-top: 1px solid var(--line);
        background: #fff;
        color: var(--ink);
      }
      .conversation-row.selected {
        background: #f5f8ff;
      }
      .conversation-row strong {
        font-size: 12px;
        display: block;
        margin-bottom: 6px;
      }
      .conversation-row p {
        font-size: 11px;
        color: #8591a4;
        margin: 0 0 8px;
      }
      .conversation-row span {
        font-size: 10px;
        color: #99a4b3;
      }
      .chat-head {
        padding: 22px 23px;
        border-bottom: 1px solid var(--line);
      }
      .chat-head p {
        margin: 7px 0 0;
        font-size: 11px;
        color: #8b97a8;
      }
      .chat-messages {
        padding: 24px;
        min-height: 315px;
        max-height: 420px;
        overflow: auto;
        display: grid;
        gap: 18px;
        align-content: start;
      }
      .message {
        font-size: 12px;
        color: #67758a;
        line-height: 1.8;
      }
      .message strong {
        font-size: 10px;
        color: #56657c;
        display: block;
        margin-bottom: 6px;
      }
      .message.user {
        background: #f1f5ff;
        border: 1px solid #e7edf9;
        border-radius: 10px;
        padding: 13px 15px;
        margin-left: 28px;
      }
      .plan-chip {
        display: flex;
        gap: 9px;
        align-items: center;
        border: 1px solid #dfe7f5;
        border-radius: 9px;
        padding: 12px;
        margin-top: 12px;
        color: #5b77b7;
        background: #f8faff;
      }
      .plan-chip .chip-text {
        flex: 1;
      }
      .plan-chip strong {
        display: block;
        font-size: 11px;
        margin: 0;
        color: #5c6e8c;
      }
      .plan-chip small {
        display: block;
        color: #8f9caf;
        font-size: 10px;
      }
      .plan-chip button {
        font-size: 10px;
        padding: 7px 10px;
      }
      .chat-composer {
        padding: 15px 23px 19px;
        border-top: 1px solid var(--line);
      }
      .chat-composer textarea {
        width: 100%;
        min-height: 70px;
        resize: vertical;
        border: 1px solid var(--line);
        border-radius: 9px;
        padding: 12px;
        font-size: 12px;
        color: #4d5e76;
      }
      .chat-composer footer {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-top: 9px;
      }
      .chat-composer small {
        font-size: 10px;
        color: #9aa4b4;
      }
      dialog {
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 25px;
        width: min(470px, calc(100% - 32px));
        color: var(--ink);
        box-shadow: 0 24px 100px #27375722;
      }
      dialog::backdrop {
        background: #172b4a35;
        backdrop-filter: blur(2px);
      }
      dialog h2 {
        font-size: 19px;
        margin-bottom: 8px;
      }
      dialog p {
        color: #7c899d;
        font-size: 12px;
      }
      dialog label {
        display: grid;
        gap: 6px;
        font-size: 11px;
        color: #6e7b90;
        margin: 15px 0;
      }
      dialog input,
      dialog textarea {
        border: 1px solid var(--line);
        border-radius: 7px;
        padding: 10px;
        font-size: 12px;
        width: 100%;
      }
      dialog textarea {
        min-height: 82px;
      }
      dialog footer {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 20px;
      }
      .review-content {
        border: 1px solid #e6ebf4;
        border-radius: 10px;
        padding: 13px 15px;
        background: #f9fbfd;
      }
      .review-content ul {
        font-size: 12px;
        color: #75839a;
        padding-left: 15px;
      }
      .toast {
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 10;
        padding: 12px 18px;
        font-size: 12px;
        background: #293b59;
        color: #fff;
        border-radius: 9px;
        box-shadow: 0 7px 25px #223e5d25;
        max-width: calc(100% - 24px);
      }
      @media (min-width: 1600px) {
        .content {
          padding-top: 35px;
        }
        .workspace-grid {
          grid-template-columns: 1fr 1.05fr;
        }
      }
      @media (max-width: 1180px) {
        .sidebar {
          padding: 23px 12px;
        }
        .app {
          grid-template-columns: 180px minmax(0, 1fr);
        }
        .content {
          padding: 25px 22px;
        }
        .topbar {
          padding: 0 22px;
        }
        .workspace-grid {
          gap: 15px;
          grid-template-columns: minmax(260px, 0.9fr) minmax(340px, 1.1fr);
        }
        .search {
          width: 220px;
        }
        .preview-tag {
          font-size: 9px;
        }
      }
      @media (max-width: 980px) {
        #detail {
          display: block;
          max-height: none;
          min-height: 0;
        }
        #detail .detail-content {
          overflow: visible;
        }
        .workspace-grid {
          grid-template-columns: 1fr;
        }
        .work-list {
          max-height: 60vh;
        }
        .work-row.selected {
          position: sticky;
          top: 0;
          z-index: 1;
        }
        .detail-head {
          padding: 20px 23px;
        }
        .topbar {
          gap: 12px;
        }
        .search {
          width: 200px;
        }
        .top-right > .preview-tag {
          display: none;
        }
        .sidebar {
          position: sticky;
          top: 0;
          height: 100vh;
        }
      }
      @media (max-width: 650px) {
        .app {
          display: block;
        }
        .sidebar {
          position: static;
          height: auto;
          padding: 16px;
          gap: 16px;
          border-right: 0;
          border-bottom: 1px solid var(--line);
        }
        .brand {
          font-size: 18px;
          padding: 0;
        }
        .sidebar .eyebrow,
        .sidebar-bottom {
          display: none;
        }
        .project-nav {
          display: flex;
          gap: 5px;
          overflow: auto;
        }
        .nav-button {
          width: auto;
          flex-shrink: 0;
          padding: 8px 10px;
          font-size: 11px;
          gap: 6px;
        }
        .nav-button svg {
          width: 15px;
          height: 15px;
        }
        .nav-button .count {
          display: none;
        }
        .nav-button .project-dot {
          width: 7px;
          height: 7px;
          margin: 3px;
        }
        .topbar {
          height: auto;
          padding: 15px 18px;
          align-items: center;
        }
        .breadcrumb {
          font-size: 11px;
          gap: 8px;
        }
        .breadcrumb > svg {
          display: none;
        }
        .search {
          width: 155px;
        }
        .search input {
          padding-right: 10px;
        }
        .shortcut {
          display: none;
        }
        .content {
          padding: 22px 16px;
        }
        .page-heading {
          align-items: flex-start;
        }
        h1 {
          font-size: 22px;
        }
        .page-heading p {
          font-size: 11px;
          max-width: 225px;
        }
        .page-heading .button {
          padding: 9px 10px;
          font-size: 10px;
        }
        .summary-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 7px;
        }
        .summary {
          padding: 13px 10px;
          gap: 7px;
        }
        .summary-icon {
          width: 26px;
          height: 26px;
          border-radius: 7px;
        }
        .summary-icon svg {
          width: 15px;
          height: 15px;
        }
        .summary strong {
          font-size: 20px;
        }
        .summary span {
          font-size: 11px;
        }
        .work-row {
          padding: 15px 16px;
        }
        .row-description,
        .row-meta,
        .badge,
        .row-time {
          font-size: 11px;
        }
        .now-strip {
          grid-template-columns: 1fr;
        }
        .work-list {
          scroll-padding: 8px;
        }
        .row-time {
          min-width: 45px;
        }
        .detail-content {
          padding: 17px 19px;
        }
        .detail-head {
          padding: 20px 19px;
        }
        .detail-tabs {
          padding: 0 19px;
        }
        .detail-footer {
          padding: 15px 19px;
        }
        .live-label {
          display: none;
        }
      }

      .now-strip {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
        padding: 14px;
        margin-bottom: 14px;
        border-radius: 8px;
        background: #f8fafc;
        border-bottom: 1px solid var(--line);
      }
      .now-cell {
        min-width: 0;
        font-size: 12px;
        line-height: 1.55;
      }
      .now-cell > strong {
        display: block;
        margin-bottom: 6px;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #64748b;
      }
      .now-cell p {
        margin: 5px 0 0;
        overflow-wrap: anywhere;
      }
      .evidence-link {
        margin-top: 6px;
        text-align: left;
        padding: 0;
        color: var(--blue);
        background: none;
        font-size: 10px;
        overflow-wrap: anywhere;
      }
      .decision-card {
        margin: 14px 0;
        padding: 14px;
        border: 1px solid #ecdab3;
        border-radius: 9px;
        background: #fffaf0;
      }
      .decision-card h3 {
        margin: 0 0 8px;
        font-size: 13px;
      }
      .decision-prompt {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        max-height: 150px;
        overflow: auto;
        font-size: 13px;
        line-height: 1.6;
      }
      .decision-card .button {
        margin-top: 12px;
      }
      .decision-history {
        list-style: none;
        padding: 0;
        display: grid;
        gap: 10px;
      }
      .decision-history li {
        padding: 12px;
        border: 1px solid var(--line);
        border-radius: 8px;
        font-size: 12px;
      }
      .decision-history p {
        margin: 6px 0;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .decision-history time {
        color: #64748b;
        font-size: 11px;
      }
      .row-time {
        align-self: center;
        margin-left: auto;
        white-space: nowrap;
        color: #64748b;
        font-size: 10px;
      }
      .row-time.historical {
        white-space: normal;
        max-width: 7rem;
        text-align: right;
      }
      .badge.attention {
        background: #fff0ec;
        color: #ac3d2c;
      }
      .summary.attention .summary-icon {
        background: #fff0ec;
        color: #ac3d2c;
      }
      .updated-label {
        font-size: 10px;
        color: #64748b;
        max-width: 165px;
      }
      #conversationLinkedWork {
        padding: 12px 18px 0;
        display: grid;
        gap: 8px;
      }
      #conversationLinkedWork:empty {
        display: none;
      }
      @media (max-width: 650px) {
        .now-strip {
          grid-template-columns: 1fr;
          gap: 10px;
        }
        .now-cell > strong {
          margin-bottom: 2px;
        }
        .now-cell p {
          margin-top: 3px;
        }
        .decision-card {
          margin: 12px;
        }
        .row-description,
        .row-meta,
        .badge,
        .row-time {
          font-size: 11px;
        }
      }
      .header-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      .sidebar-actions {
        display: grid;
        gap: 4px;
      }
      .sidebar-actions .nav-button {
        font-size: 12px;
      }
      #workspaceActionDialog {
        width: min(1000px, calc(100% - 32px));
        max-height: calc(100vh - 40px);
        padding: 0;
        overflow: auto;
      }
      #workspaceActionDialog > header {
        position: sticky;
        top: 0;
        z-index: 2;
        display: flex;
        justify-content: space-between;
        align-items: center;
        background: #fff;
        padding: 18px 22px;
        border-bottom: 1px solid var(--line);
      }
      #workspaceActionBody {
        padding: 15px 20px;
      }
      #workspaceActionBody #workflowList {
        max-height: 9rem;
        overflow: auto;
      }
      #workspaceActionDialog.response-dialog {
        width: min(640px, calc(100% - 24px));
      }
      #workspaceActionDialog.response-dialog > header {
        padding: 14px 18px;
      }
      #workspaceActionDialog.response-dialog #workspaceActionBody {
        padding: 14px 18px;
      }
      #workflowRespond {
        min-width: 0;
      }
      #workflowRespondContext {
        color: var(--muted);
        font-size: 12px;
        margin: 0 0 12px;
      }
      #workflowRespond h3,
      #workflowAgentRequestPrompt {
        font-family: inherit;
        font-size: 16px;
        font-weight: 600;
        line-height: 1.5;
        margin: 0 0 14px;
        max-height: 140px;
        overflow: auto;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
      }
      #workflowRespond fieldset {
        border: 0;
        padding: 0;
        margin: 0 0 12px;
        display: flex;
        flex-wrap: wrap;
        gap: 8px 16px;
      }
      #workflowRespond legend {
        font-size: 12px;
        color: var(--muted);
        margin-bottom: 8px;
      }
      #workflowRespond fieldset label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin: 0;
        font-size: 13px;
        text-transform: none;
        letter-spacing: normal;
      }
      #workflowRespond fieldset input {
        width: auto;
        margin: 0;
      }
      #workflowRespond textarea {
        width: 100%;
        min-height: 96px;
        height: 110px;
        margin: 6px 0 12px;
        resize: vertical;
      }
      #workflowRespond #workflowHumanRule,
      #workflowRespondStatus {
        font-size: 12px;
        color: var(--muted);
        overflow-wrap: anywhere;
      }
      #workflowRespondStatus:empty {
        display: none;
      }
      #workflowRespondEvidence {
        margin: 16px 0 10px;
        font-size: 12px;
      }
      #workflowRespondAdvanced {
        font-size: 12px;
        background: transparent;
        color: var(--blue);
        border: 0;
        border-radius: 0;
        padding: 0;
        box-shadow: none;
        text-decoration: underline;
        text-underline-offset: 3px;
      }
      #workflowHumanFormatHelp {
        font-size: 12px;
        color: var(--muted);
        line-height: 1.5;
      }
      #workflowHumanAdvanced {
        margin: 10px 0;
        font-size: 12px;
      }
      #workflowHumanAdvanced > label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin: 10px 0;
        text-transform: none;
        letter-spacing: normal;
      }
      #workflowHumanAdvanced input {
        width: auto;
        margin: 0;
      }
      #workspaceActionDialog.response-dialog #workflowHumanSubmit {
        position: sticky;
        bottom: 8px;
        z-index: 1;
      }
      #workflowHumanSubmit,
      #workflowAgentRespond {
        display: block;
        background: var(--accent);
        color: white;
      }
      #workflowBuilder {
        min-width: 0;
      }
      #workflowBuilder > h3 {
        font-family: inherit;
      }
      #workflowBuilder input:not([type="checkbox"]),
      #workflowBuilder textarea,
      #workflowBuilder select {
        width: 100%;
        min-width: 0;
      }
      #workflowBuilder > label,
      .workflow-builder-step > label {
        display: block;
        margin-top: 12px;
      }
      .workflow-builder-step {
        padding: 16px;
        margin: 18px 0;
        border: 1px solid var(--line);
        border-radius: 12px;
        min-width: 0;
      }
      .workflow-builder-step h4 {
        font-family: inherit;
        margin: 0 0 12px;
      }
      .workflow-builder-step small,
      .workflow-builder-step p {
        font-size: 12px;
        color: var(--muted);
        overflow-wrap: anywhere;
      }
      .workflow-builder-step small {
        display: block;
        margin: 5px 0 12px;
      }
      .workflow-builder-step details {
        margin: 12px 0;
      }
      .workflow-builder-step fieldset label,
      .workflow-builder-step [data-field="previousGroup"] label,
      .workflow-builder-step [data-field="approvalGroup"] label {
        display: flex;
        align-items: center;
        gap: 8px;
        text-transform: none;
        letter-spacing: normal;
      }
      .workflow-builder-step input[type="checkbox"] {
        width: auto;
        margin: 0;
      }
      .workflow-builder-step pre {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        max-height: 16rem;
        overflow: auto;
      }
      .workflow-builder-order {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 14px;
      }
      #workflowBuilderAdvanced {
        background: transparent;
        color: var(--blue);
        border: 1px solid var(--line);
        box-shadow: none;
      }
      .recorded-review {
        margin: 14px 0;
        padding: 12px;
        border: 1px solid var(--line);
        border-radius: 10px;
        background: #f8faff;
        min-width: 0;
      }
      .recorded-review h4 {
        font-family: inherit;
        margin: 0 0 6px;
        font-size: 13px;
      }
      .recorded-review > p,
      #workflowHumanScope {
        font-size: 12px;
        color: var(--muted);
        line-height: 1.5;
      }
      .recorded-review-values {
        max-height: 9rem;
        overflow: auto;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
        font-size: 13px;
      }
      .recorded-review-values section + section {
        margin-top: 12px;
      }
      .recorded-review-values p {
        margin: 4px 0 8px;
      }
      .recorded-review-values strong {
        font-size: 12px;
      }
      .recorded-review details {
        font-size: 12px;
        margin-top: 8px;
      }
      #workflowBuilderSave {
        background: var(--accent);
        color: white;
        margin: 12px 0;
      }
      #workspaceActionStatus {
        font-size: 12px;
        color: #8a641d;
      }
      #workspaceActionReopen {
        margin-bottom: 12px;
      }
      .legacy-controls-scope {
        --bg: #f5f7fb;
        --panel: #fff;
        --ink: #202b3c;
        --muted: #667387;
        --line: #e5eaf2;
        --accent: #335eea;
        --glow: rgba(51, 94, 234, 0.12);
        font-family: inherit;
      }
      .legacy-controls-scope .panel {
        border: 0;
        border-radius: 0;
        box-shadow: none;
        background: #fff;
      }
      .legacy-controls-scope button {
        background: #335eea;
        color: #fff;
        border: 1px solid #335eea;
        box-shadow: none;
        border-radius: 8px;
        font-size: 12px;
      }
      .legacy-controls-scope input,
      .legacy-controls-scope textarea,
      .legacy-controls-scope select {
        font: inherit;
        border: 1px solid #dfe5ef;
        border-radius: 8px;
        padding: 8px;
        color: #202b3c;
        background: #fff;
        max-width: 100%;
      }
      .legacy-controls-scope label {
        font-size: 11px;
        text-transform: none;
        letter-spacing: 0;
      }
      .legacy-controls-scope pre {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .legacy-controls-scope .chat-shell {
        display: flex;
        flex-direction: column;
        min-height: 0;
        max-height: 780px;
        overflow: hidden;
      }
      .legacy-controls-scope .panel-header {
        background: #fff;
        border-bottom: 1px solid #e5eaf2;
        padding: 20px;
      }
      .legacy-controls-scope .panel-header h1,
      .legacy-controls-scope .panel-header h2 {
        font-family: inherit;
      }
      .legacy-controls-scope .thread {
        max-height: 460px;
        min-height: 180px;
        overflow: auto;
        padding: 18px;
        flex: 1;
      }
      .legacy-controls-scope .composer {
        background: #fff;
        padding: 16px 20px;
        border-top: 1px solid #e5eaf2;
        display: grid;
        gap: 8px;
      }
      .legacy-controls-scope .composer textarea {
        min-height: 70px;
      }
      .legacy-controls-scope .bubble {
        animation: none;
      }
      .legacy-controls-scope .bubble {
        max-width: 100%;
        font-size: 13px;
      }
      .legacy-controls-scope .status {
        font-size: 11px;
      }
      @media (max-width: 650px) {
        .header-actions {
          justify-content: flex-start;
        }
        .page-heading {
          flex-wrap: wrap;
        }
        .sidebar-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 2px;
        }
        .sidebar-actions .nav-button {
          padding: 5px 8px;
          font-size: 10px;
        }
        #workspaceActionDialog {
          width: calc(100% - 16px);
          max-height: calc(100vh - 16px);
        }
        #workspaceActionBody {
          padding: 12px;
        }
        .legacy-controls-scope .chat-shell {
          max-height: none;
        }
      }
    </style>
  </head>
  <body>
    <svg aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">
      <defs>
        <symbol id="i-grid" viewBox="0 0 24 24">
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </symbol>
        <symbol id="i-work" viewBox="0 0 24 24">
          <rect x="4" y="5" width="16" height="16" rx="3" />
          <path d="M9 5V3h6v2M8 11l1.5 1.5L12 10m-4 7h8m-2-5h2" />
        </symbol>
        <symbol id="i-chat" viewBox="0 0 24 24">
          <path d="M21 11a8 8 0 0 1-8 8H7l-4 3V11a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z" />
          <path d="M7 9h10M7 13h7" />
        </symbol>
        <symbol id="i-search" viewBox="0 0 24 24">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m16 16 5 5" />
        </symbol>
        <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></symbol>
        <symbol id="i-arrow" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6" /></symbol>
        <symbol id="i-check" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6" /></symbol>
        <symbol id="i-clock" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </symbol>
        <symbol id="i-alert" viewBox="0 0 24 24">
          <path d="m10 4-8 14a2 2 0 0 0 2 3h16a2 2 0 0 0 2-3L14 4a2 2 0 0 0-4 0Z" />
          <path d="M12 9v4m0 4h.01" />
        </symbol>
        <symbol id="i-play" viewBox="0 0 24 24"><path d="m8 5 11 7-11 7Z" /></symbol>
        <symbol id="i-folder" viewBox="0 0 24 24">
          <path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
        </symbol>
        <symbol id="i-link" viewBox="0 0 24 24">
          <path
            d="m10 14 4-4m-6 6-2 2a4 4 0 0 1-6-6l4-4m12 0 2-2a4 4 0 0 1 6 6l-4 4"
            transform="translate(2 0) scale(.85)"
          />
        </symbol>
        <symbol id="i-tools" viewBox="0 0 24 24">
          <path d="M15 4a6 6 0 0 0-7 7l-5 5a3 3 0 0 0 4 4l5-5a6 6 0 0 0 7-7l-4 3-3-3Z" />
        </symbol>
        <symbol id="i-spark" viewBox="0 0 24 24">
          <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" />
        </symbol>
      </defs>
    </svg>
    <div class="app">
      <aside class="sidebar" aria-label="Project navigation">
        <div class="brand">
          <div class="brand-mark">
            <svg><use href="#i-grid" /></svg>
          </div>
          Workspace
        </div>
        <div>
          <p class="eyebrow">Your projects</p>
          <nav class="project-nav" id="projects" aria-label="Projects">
            <span class="empty">Loading projects…</span>
          </nav>
        </div>
        <div class="sidebar-actions">
          <button class="nav-button" id="shellNewProject">＋ New project</button
          ><button class="nav-button" id="shellEditProject">Edit selected project</button
          ><button class="nav-button" id="shellManageWorkspace">Manage workspace</button
          ><button class="nav-button" id="shellToolsActivity">Tools &amp; activity</button>
        </div>
        <div class="sidebar-bottom">
          <div>
            <span class="preview-tag"><span class="dot"></span>Live workspace</span>
            <p class="sidebar-note" style="margin-top:9px">
              <span id="workspacePersistence">Reading storage status…</span>
            </p>
          </div>
          <div class="account">
            <span class="avatar"
              ><svg><use href="#i-grid" /></svg
            ></span>
            <div>Operator workspace<small>Authenticated live reads</small></div>
          </div>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <div class="breadcrumb">
            <svg><use href="#i-grid" /></svg><span>Workspace</span><span>/</span
            ><strong id="breadcrumbProject">All projects</strong>
          </div>
          <div class="top-right">
            <label class="search"
              ><svg><use href="#i-search" /></svg
              ><input
                id="search"
                aria-label="Search work and conversations"
                placeholder="Search your workspace…"
              /><span class="shortcut">⌘ K</span></label
            ><span class="preview-tag"><span class="dot"></span>Workspace</span>
          </div>
        </header>
        <main class="content">
          <div class="page-heading">
            <div>
              <h1 id="pageTitle">Your work, at a glance.</h1>
              <p id="pageDescription">See what needs you, what’s moving, and what comes next.</p>
            </div>
            <div class="header-actions">
              <button class="button" id="shellNewConversation">New conversation</button
              ><button class="button" id="shellNewAgentTask">Agent task</button
              ><button class="button primary" id="shellNewWorkflow">New workflow</button
              ><button class="button" id="refresh">
                <svg><use href="#i-clock" /></svg>Refresh</button
              ><span class="updated-label" id="loadStatus" role="status">Reading workspace…</span>
            </div>
          </div>
          <p id="workspaceActionStatus" role="status" hidden></p>
          <button class="button" id="workspaceActionReopen" hidden>Resume open controls</button>

          <div
            id="loadErrors"
            role="alert"
            style="margin-bottom:14px;font-size:12px;color:#9a6414"
            hidden
          ></div>
          <div class="tabs" role="tablist" aria-label="Workspace view">
            <button
              class="tab active"
              id="workTab"
              role="tab"
              aria-selected="true"
              aria-controls="workView"
            >
              <svg><use href="#i-work" /></svg>Work<span class="tab-count" id="workCount"
                >—</span
              ></button
            ><button
              class="tab"
              id="conversationsTab"
              role="tab"
              aria-selected="false"
              aria-controls="conversationsView"
            >
              <svg><use href="#i-chat" /></svg>Conversations<span
                class="tab-count"
                id="conversationCount"
                >—</span
              >
            </button>
          </div>
          <section id="workView" role="tabpanel" aria-labelledby="workTab">
            <div class="summary-grid">
              <button
                class="summary needs"
                data-status="needs"
                aria-label="Filter work needing your input"
              >
                <div class="summary-icon">
                  <svg><use href="#i-alert" /></svg>
                </div>
                <div><strong id="needsCount">—</strong><span>Needs you</span></div></button
              ><button
                class="summary"
                data-status="in_progress"
                aria-label="Filter work in progress"
              >
                <div class="summary-icon">
                  <svg><use href="#i-clock" /></svg>
                </div>
                <div>
                  <strong id="inProgressCount">—</strong><span>In progress</span
                  ><span id="progressBreakdown"></span>
                </div></button
              ><button class="summary ready" data-status="ready" aria-label="Filter ready work">
                <div class="summary-icon">
                  <svg><use href="#i-play" /></svg>
                </div>
                <div><strong id="readyCount">—</strong><span>Ready to start</span></div>
              </button>
              <button
                class="summary attention"
                data-status="attention"
                id="attentionCard"
                hidden
                aria-label="Filter work needing attention"
              >
                <div class="summary-icon">
                  <svg><use href="#i-alert" /></svg>
                </div>
                <div><strong id="attentionCount">—</strong><span>Needs attention</span></div>
              </button>
            </div>
            <div class="workspace-grid">
              <section class="card" aria-label="Work list">
                <div class="list-heading">
                  <h2>Your work</h2>
                  <small id="visibleCount">Loading…</small>
                </div>
                <div class="list-filters">
                  <button class="filter selected" data-status="outstanding">Outstanding <span id="outstandingCount">—</span></button
                  ><button class="filter" data-status="needs">Needs you</button
                  ><button class="filter" data-status="in_progress">In progress</button
                  ><button class="filter" data-status="ready">Ready</button
                  ><button class="filter" data-status="attention">Attention</button
                  ><button class="filter" data-status="completed">Completed</button
                  ><button class="filter" data-status="all">All</button>
                </div>
                <div class="work-list" id="workList"><p class="empty">Loading actual work…</p></div>
                <div class="list-footer">
                  <span id="workSource">Recorded workflows and coding plans</span
                  ><span>Live data</span>
                </div>
              </section>
              <section class="card" id="detail" aria-label="Selected work">
                <p class="empty">Choose a task to see its goal, steps and results.</p>
              </section>
            </div>
          </section>
          <section id="conversationsView" role="tabpanel" aria-labelledby="conversationsTab" hidden>
            <div class="workspace-grid">
              <section class="card" aria-label="Conversation list">
                <div class="list-heading">
                  <h2>Conversations</h2>
                  <small>Saved history</small>
                </div>
                <div class="conversation-list" id="conversationList"></div>
                <div class="list-footer"><span>Your saved conversations and linked work</span></div>
              </section>
              <section class="card" id="conversationDetail" aria-label="Selected conversation">
                <p class="empty">Choose a saved conversation.</p>
              </section>
            </div>
          </section>
          <p class="demo-note">
            Plans describe the work. Conversations help shape it. Every execution starts with an
            explicit action.
          </p>
        </main>
      </div>
    </div>
    <dialog id="workspaceActionDialog" aria-labelledby="workspaceActionTitle">
      <header>
        <h2 id="workspaceActionTitle">Work controls</h2>
        <button class="button" id="workspaceActionClose" aria-label="Close work controls">
          Close
        </button>
      </header>
      <p
        id="workspaceActionDialogStatus"
        role="status"
        hidden
        style="padding:0 20px;color:#9a6414"
      ></p>
      <div id="workspaceActionBody" class="legacy-controls-scope"></div>
    </dialog>
    <script>
      (function () {
        const $ = (id) => document.getElementById(id);
        const icon = (name) => '<svg aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
        const escape = (text) =>
          String(text ?? "").replace(
            /[&<>"']/g,
            (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
          );
        let snapshot = null,
          project = "all",
          status = "outstanding",
          view = "work",
          selected = null,
          selectedConversation = null,
          query = "",
          detailTab = "plan",
          chosenStep = null;
        let detailVersion = 0,
          conversationVersion = 0,
          loadedDetail = null,
          loadingWorkspace = false,
          loadedScope = "all",
          pendingWorkspaceReload = false;
        const detailCache = new Map(),
          historyCache = new Map(),
          requests = new Set();
        const labels = {
          needs_decision: "Needs your decision",
          needs_attention: "Needs attention",
          waiting_input: "Needs your input",
          uncertain: "Outcome unknown",
          failed: "Failed",
          stopped: "Stopped",
          unavailable: "Could not be read",
          invalid: "Needs attention",
          awaiting_review: "Needs review",
          ready: "Ready to start",
          todo: "Ready to start",
          pending: "Not started",
          blocked: "Blocked",
          stuck: "Needs attention",
          running: "Running",
          in_progress: "In progress",
          allocated: "Allocated, not confirmed running",
          active: "Allocated, not confirmed running",
          completed: "Completed",
          complete: "Completed",
          done: "Completed",
          accepted: "Accepted",
          cancelled: "Cancelled",
          review_pending: "Needs review"
        };
        function stateLabel(value) {
          return labels[value] || String(value || "Unknown").replace(/_/g, " ");
        }
        function digestOf(item) {
          return (
            item.digest || {
              state: "needs_attention",
              stateText: item.error || "Work summary could not be read.",
              errors: [item.error || "Work summary unavailable."],
              next: null,
              decision: null,
              progress: null,
              verification: null,
              lastOutcome: null,
              run: null
            }
          );
        }
        function bucket(value) {
          if (value === "completed") return "completed";
          if (value === "cancelled") return "cancelled";
          if (value === "needs_decision") return "needs";
          if (["running", "allocated"].includes(value)) return "in_progress";
          if (value === "ready") return "ready";
          return "attention";
        }
        function badge(item) {
          const state = item.digest ? item.digest.state : item.status;
          return '<span class="badge ' + bucket(state) + '">' + escape(stateLabel(state)) + "</span>";
        }
        function localTime(value) {
          return value && Number.isFinite(Date.parse(value))
            ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
            : "time not recorded";
        }
        function relativeTime(value) {
          if (!value || !Number.isFinite(Date.parse(value))) return "Time unavailable";
          const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
          return minutes < 1
            ? "Just now"
            : minutes < 60
              ? minutes + " min ago"
              : minutes < 1440
                ? Math.floor(minutes / 60) + " h ago"
                : Math.floor(minutes / 1440) + " d ago";
        }
        function rowSummary(digest) {
          if (digest.state === "needs_decision")
            return digest.decision?.prompt?.slice(0, 80) || digest.stateText;
          if (digest.state === "completed")
            return digest.lastOutcome
              ? "Done " + localTime(digest.lastOutcome.at) + " · " + digest.lastOutcome.name
              : digest.stateText;
          if (digest.state === "needs_attention")
            return digest.stateText + (digest.errors?.length ? " " + digest.errors[0] : "");
          if (digest.state === "allocated" || digest.run?.current === false)
            return (
              digest.stateText +
              (digest.next ? " Next: " + digest.next.name + " · " + digest.next.actor : "")
            );
          return digest.next ? "Next: " + digest.next.name + " · " + digest.next.actor : digest.stateText;
        }
        function conversationState(item) {
          return item.status === "running"
            ? "Reply in progress"
            : item.status === "expired"
              ? "Expired"
              : item.status === "needs_attention"
                ? "Needs attention"
                : "Idle";
        }
        function projectName(id) {
          if (!id) return "General";
          const recorded = snapshot?.projects.find((entry) => entry.id === id);
          return recorded?.name || (snapshot ? "Project unavailable" : "Project details loading");
        }
        function codingStateLabel(value) {
          return ["in_progress", "active"].includes(value)
            ? "Allocated, running unknown"
            : stateLabel(value);
        }
        async function read(path, input) {
          const controller = new AbortController();
          requests.add(controller);
          const timer = setTimeout(() => controller.abort(), 15000);
          try {
            const response = await fetch(path, {
              method: input === undefined ? "GET" : "POST",
              credentials: "same-origin",
              cache: "no-store",
              headers: input === undefined ? {} : { "Content-Type": "application/json" },
              body: input === undefined ? undefined : JSON.stringify(input),
              signal: controller.signal
            });
            const text = await response.text();
            if (text.length > 2097152) throw new Error("The response exceeds this view’s read limit.");
            let data;
            try {
              data = JSON.parse(text);
            } catch {
              throw new Error("The service returned an unreadable response.");
            }
            if (!response.ok) {
              if (response.status === 401) throw new Error("Pair this browser to view your workspace.");
              throw new Error(
                typeof data.error === "string"
                  ? data.error
                  : typeof data.message === "string"
                    ? data.message
                    : "Request failed (" + response.status + ")."
              );
            }
            return data;
          } catch (error) {
            if (controller.signal.aborted) throw new Error("The read timed out. Refresh to try again.");
            throw error;
          } finally {
            clearTimeout(timer);
            requests.delete(controller);
          }
        }
        function scopedWork() {
          return (snapshot?.work || []).filter((item) => project === "all" || item.projectId === project);
        }
        function visibleWork() {
          return scopedWork().filter(
            (item) =>
              (status === "all" ||
                (status === "outstanding"
                  ? !["completed", "cancelled"].includes(bucket(digestOf(item).state))
                  : bucket(digestOf(item).state) === status)) &&
              (item.name + " " + projectName(item.projectId) + " " + (item.nextStep || ""))
                .toLowerCase()
                .includes(query)
          );
        }
        function visibleConversations() {
          return (snapshot?.conversations || []).filter(
            (item) =>
              (project === "all" || item.projectId === project) &&
              !item.archived &&
              (item.title + " " + item.preview).toLowerCase().includes(query)
          );
        }
        function renderNavigation() {
          const projects = [
            { id: "all", name: "All projects" },
            ...(snapshot?.projects || []).filter((item) => !item.archived)
          ];
          $("projects").innerHTML = projects
            .map(
              (item) =>
                '<button class="nav-button ' +
                (project === item.id ? "selected" : "") +
                '" data-project="' +
                escape(item.id) +
                '"' +
                (project === item.id ? ' aria-current="page"' : "") +
                ">" +
                (item.id === "all" ? icon("grid") : '<span class="project-dot"></span>') +
                escape(item.name) +
                '<span class="count">' +
                (item.id === "all"
                  ? (snapshot?.work || []).length
                  : (snapshot?.work || []).filter((work) => work.projectId === item.id).length) +
                "</span></button>"
            )
            .join("");
          $("projects")
            .querySelectorAll("[data-project]")
            .forEach((button) =>
              button.addEventListener("click", () => {
                requestProject(button.dataset.project);
              })
            );
          $("breadcrumbProject").textContent = project === "all" ? "All projects" : projectName(project);
        }
        function renderCounts() {
          const work = scopedWork(),
            count = (state) => work.filter((item) => digestOf(item).state === state).length;
          $("outstandingCount").textContent = work.filter(
            (item) => !["completed", "cancelled"].includes(digestOf(item).state)
          ).length;
          $("needsCount").textContent = count("needs_decision");
          const running = count("running"),
            allocated = count("allocated");
          $("inProgressCount").textContent = running + allocated;
          $("progressBreakdown").textContent = running + " recorded running · allocation unconfirmed";
          $("readyCount").textContent = count("ready");
          const attention = work.filter((item) => bucket(digestOf(item).state) === "attention").length;
          $("attentionCount").textContent = attention;
          $("attentionCard").hidden = attention === 0;
          $("workCount").textContent = work.length;
          $("conversationCount").textContent = visibleConversations().length;
          document
            .querySelectorAll("[data-status]")
            .forEach((button) => button.classList.toggle("selected", button.dataset.status === status));
        }
        function renderList() {
          const items = visibleWork();
          $("visibleCount").textContent = items.length + " " + (items.length === 1 ? "item" : "items");
          $("workList").innerHTML = items.length
            ? items
                .map((item) => {
                  const digest = digestOf(item);
                  return (
                    '<button class="work-row ' +
                    (item.id === selected ? "selected" : "") +
                    '" data-work="' +
                    escape(item.id) +
                    '" aria-pressed="' +
                    (item.id === selected) +
                    '"><span class="work-icon">' +
                    icon(digest.state === "completed" ? "check" : "work") +
                    '</span><span class="row-body"><span class="row-title">' +
                    escape(item.name) +
                    '</span><span class="row-description">' +
                    escape(rowSummary(digest)) +
                    "</span>" +
                    (digest.alsoAllocated > 0
                      ? '<span class="row-allocation">Also allocated: ' +
                        digest.alsoAllocated +
                        (digest.alsoAllocated === 1 ? " item" : " items") +
                        " · running is not confirmed</span>"
                      : "") +
                    '<span class="row-meta">' +
                    badge({ digest }) +
                    (project === "all"
                      ? '<span class="project-label">' + escape(projectName(item.projectId)) + "</span>"
                      : "") +
                    '</span></span><time class="row-time' +
                    (digest.run?.current === false ? " historical" : "") +
                    '" title="' +
                    escape(
                      digest.run?.current === false
                        ? digest.run.updatedAt || "Historical run time unavailable"
                        : digest.run?.updatedAt || digest.lastOutcome?.at || "No timestamp recorded"
                    ) +
                    '">' +
                    (digest.run?.current === false ? "Last run (historical): " : "") +
                    escape(
                      relativeTime(
                        digest.run?.current === false
                          ? digest.run.updatedAt
                          : digest.run?.updatedAt || digest.lastOutcome?.at
                      )
                    ) +
                    "</time>" +
                    icon("arrow").replace("<svg ", '<svg class="row-arrow" ') +
                    "</button>"
                  );
                })
                .join("")
            : '<p class="empty">No recorded work matches this selection.</p>';
          $("workList")
            .querySelectorAll("[data-work]")
            .forEach((button) =>
              button.addEventListener("click", () => {
                selected = button.dataset.work;
                chosenStep = null;
                detailTab = "plan";
                renderList();
                loadDetail();
                if (innerWidth < 980)
                  $("workList")
                    .querySelector('[aria-pressed="true"]')
                    ?.scrollIntoView({ block: "nearest" });
              })
            );
          pinSelectedWork();
        }
        function pinSelectedWork(scrollPage = false) {
          if (view !== "work") return;
          const list = $("workList"),
            row = list.querySelector('[aria-pressed="true"]');
          if (!row || !list.clientHeight) return;
          const box = list.getBoundingClientRect(),
            rect = row.getBoundingClientRect();
          const top = box.top + list.clientTop,
            bottom = top + list.clientHeight;
          if (rect.top < top) list.scrollTop += rect.top - top;
          else if (rect.bottom > bottom) list.scrollTop += rect.bottom - bottom;
          if (scrollPage && innerWidth < 980 && !dialog.open) row.scrollIntoView({ block: "nearest" });
        }
        function detailDigest(item) {
          return loadedDetail?.digest || digestOf(item);
        }
        function verificationText(digest) {
          if (digest.verification?.by === "hekate_accepted")
            return "Leaf accepted in Hekate · task not verified";
          if (digest.approval) return "Approval recorded · task not verified";
          return "Not verified";
        }
        function decisionEvidence(item, digest) {
          if (item.kind !== "workflow" || !digest.decision) return "";
          const record = loadedDetail;
          if (record?.runError)
            return (
              '<p role="status">Recorded execution could not be read: ' + escape(record.runError) + "</p>"
            );
          if (!record) return "<p>Recorded input and results are loading.</p>";
          if (!record.run || !record.plan)
            return "<p>No execution record is available for this decision. Refresh before responding.</p>";
          if (record.run.revision !== record.plan.revision || record.run.id !== digest.run?.id)
            return "<p>Current execution evidence is unavailable. Refresh before responding.</p>";
          const render = $("workflowPanel")?.renderRecordedEvidence;
          return typeof render === "function"
            ? render(record.run, digest.decision.stepId).outerHTML
            : "<p>Open the configured workflow controls to inspect the recorded values.</p>";
        }
        function attentionInstruction(digest) {
          if (digest.run?.status === "uncertain")
            return "Inspect the recorded outcome and any external effects before starting a new run.";
          if (digest.run?.status === "stopped") return "Review the stopped run and its partial results.";
          if (digest.run?.status === "failed") return "Review the failure and any recorded results.";
          return "Review the recorded problem and available evidence before starting work.";
        }
        function attentionAction(digest) {
          return digest.run?.status === "uncertain"
            ? "Review uncertain outcome"
            : digest.run?.status === "stopped"
              ? "Review partial results"
              : digest.run?.status === "failed"
                ? "Review failure"
                : "Review recorded problem";
        }
        function nowHtml(item) {
          const digest = detailDigest(item),
            next =
              digest.state === "needs_attention"
                ? attentionInstruction(digest)
                : digest.decision
                  ? "Your decision: " + (digest.next?.name || digest.decision.stepId)
                  : digest.state === "completed"
                    ? "Nothing, completed " + localTime(digest.lastOutcome?.at)
                    : digest.next
                      ? (digest.state === "running" ? "Waiting for " : "Next: ") +
                        digest.next.actor +
                        " · " +
                        digest.next.name
                      : digest.stateText;
          const evidence = digest.run
            ? '<button class="evidence-link" data-open-evidence title="' +
              escape(digest.run.id) +
              '">Evidence: run ' +
              escape(digest.run.id.slice(0, 8)) +
              ", revision " +
              escape(digest.run.revision) +
              (digest.run.current === false ? " · historical" : "") +
              "</button>"
            : '<button class="evidence-link" data-open-evidence title="' +
              escape(item.id) +
              '">Evidence: plan ' +
              escape(item.id.slice(0, 8)) +
              (digest.revision == null
                ? ", revision unavailable"
                : ", revision " + escape(digest.revision)) +
              "</button>";
          return (
            '<section class="now-strip" aria-label="Current work summary"><div class="now-cell"><strong>Status</strong>' +
            badge({ digest }) +
            "<p>" +
            escape(digest.stateText) +
            "</p>" +
            (digest.errors?.length ? '<p role="status">' + escape(digest.errors.join(" ")) + "</p>" : "") +
            (digest.progress
              ? "<p>" +
                digest.progress.done +
                " of " +
                digest.progress.total +
                (item.kind === "coding" ? " items accepted" : " steps complete") +
                "</p>"
              : "") +
            evidence +
            '</div><div class="now-cell"><strong>Next action</strong><p>' +
            escape(next) +
            "</p>" +
            (digest.lastOutcome
              ? "<p>" +
                (digest.run?.current === false ? "Historical last outcome: " : "Last outcome: ") +
                escape(digest.lastOutcome.name) +
                " · " +
                escape(digest.lastOutcome.summary) +
                " · " +
                escape(localTime(digest.lastOutcome.at)) +
                "</p>"
              : "") +
            '</div><div class="now-cell"><strong>Verification</strong><p>' +
            escape(verificationText(digest)) +
            "</p>" +
            (digest.verification?.by === "hekate_accepted"
              ? '<button class="evidence-link" data-open-evidence>Acceptance evidence: ' +
                escape(digest.verification.ref) +
                "</button>"
              : digest.approval
                ? '<button class="evidence-link" data-open-evidence>Approval evidence: ' +
                  escape(digest.approval.ref) +
                  "</button>"
                : "") +
            "</div></section>" +
            (digest.decision
              ? '<section class="decision-card" aria-label="Pending decision"><h3>Your decision</h3><div class="decision-prompt">' +
                escape(digest.decision.prompt) +
                "</div>" +
                (digest.decision.tool
                  ? "<p>Requested tool: " + escape(digest.decision.tool) + "</p>"
                  : "") +
                decisionEvidence(item, digest) +
                '<button class="button primary" id="respondDecision">' +
                (item.kind === "coding" ? "Review details" : "Respond") +
                "</button>" +
                (item.kind === "coding"
                  ? "<p>Submit approval in the coding coordinator. These controls show recorded details.</p>"
                  : "") +
                "</section>"
              : "")
          );
        }
        function detailShell(item, body, footer = true) {
          const description =
            loadedDetail?.digest?.goal ||
            loadedDetail?.plan?.definition.description ||
            digestOf(item).goal ||
            (item.kind === "coding"
              ? "Recorded coding plan. Inspect its saved state and use the prepared host controls when available."
              : "Goal and step details are recorded in the saved plan.");
          return (
            '<header class="detail-head"><div class="detail-meta"><span class="detail-project">' +
            icon("folder") +
            escape(projectName(item.projectId)) +
            " / " +
            (item.kind === "coding" ? "Coding plan" : "Workflow") +
            "</span>" +
            badge({ digest: detailDigest(item) }) +
            "</div><h2>" +
            escape(item.name) +
            '</h2><p class="goal">' +
            escape(description) +
            '</p></header><div class="detail-tabs" role="tablist" aria-label="Task detail"><button class="tab ' +
            (detailTab === "plan" ? "active" : "") +
            '" data-detail-tab="plan" role="tab" aria-selected="' +
            (detailTab === "plan") +
            '">Plan & result</button><button class="tab ' +
            (detailTab === "activity" ? "active" : "") +
            '" data-detail-tab="activity" role="tab" aria-selected="' +
            (detailTab === "activity") +
            '">Activity</button></div><div class="detail-content">' +
            nowHtml(item) +
            body +
            "</div>" +
            (footer
              ? '<footer class="detail-footer"><small>' +
                (detailDigest(item).state === "needs_attention"
                  ? item.kind === "workflow"
                    ? "New runs start from the first step."
                    : "Recorded plan details"
                  : detailDigest(item).state === "needs_decision"
                    ? "Advanced plan controls"
                    : "Plan controls") +
                '</small><button class="button" id="openCurrent">' +
                (detailDigest(item).state === "needs_attention"
                  ? attentionAction(detailDigest(item))
                  : "Open controls") +
                "</button>" +
                (item.kind === "workflow" && detailDigest(item).state === "ready"
                  ? '<button class="button primary" id="runCurrent">Run plan</button>'
                  : "") +
                "</footer>"
              : "")
          );
        }
        function bindDetail(item) {
          $("detail")
            .querySelectorAll("[data-detail-tab]")
            .forEach((button) =>
              button.addEventListener("click", () => {
                detailTab = button.dataset.detailTab;
                renderDetail();
              })
            );
          $("detail")
            .querySelectorAll("[data-step]")
            .forEach((button) =>
              button.addEventListener("click", () => {
                chosenStep = Number(button.dataset.step);
                renderDetail();
              })
            );
          if ($("openCurrent")) $("openCurrent").addEventListener("click", () => openCurrent(item));
          ["respondDecision", "respondCurrent"].forEach((id) => {
            if ($(id))
              $(id).addEventListener("click", () => openCurrent(item, false, item.kind === "workflow"));
          });
          if ($("runCurrent")) $("runCurrent").addEventListener("click", () => openCurrent(item, true));
          setActionButtons();
          $("detail")
            .querySelectorAll("[data-open-evidence]")
            .forEach((button) => button.addEventListener("click", () => openCurrent(item)));
        }
        function compact(value) {
          if (value === undefined || value === null) return "No value recorded";
          if (typeof value === "string") return value;
          if (typeof value === "boolean") return value ? "Yes" : "No";
          if (typeof value === "number") return String(value);
          if (Array.isArray(value)) return value.length + " recorded items";
          const entries = Object.entries(value);
          if (!entries.length) return "No extra input";
          return entries
            .slice(0, 4)
            .map(
              ([key, entry]) =>
                key +
                ": " +
                (entry && typeof entry === "object"
                  ? entry.$step
                    ? "from " + entry.$step
                    : Array.isArray(entry)
                      ? entry.length + " items"
                      : "recorded data"
                  : String(entry))
            )
            .join(" · ");
        }
        function resultHtml(output) {
          if (output === undefined) return "<p>No output has been recorded for this step.</p>";
          if (typeof output === "string")
            return '<p style="white-space:pre-wrap">' + escape(output) + "</p>";
          if (output && typeof output.text === "string")
            return '<p style="white-space:pre-wrap">' + escape(output.text) + "</p>";
          if (output && typeof output.approved === "boolean")
            return (
              "<p><strong>" +
              (output.approved ? "Approved" : "Not approved") +
              "</strong></p>" +
              (typeof output.note === "string" ? "<p>" + escape(output.note) + "</p>" : "")
            );
          const data = output && output.data && typeof output.data === "object" ? output.data : output;
          if (!data || typeof data !== "object") return "<p>" + escape(compact(data)) + "</p>";
          const entries = Object.entries(data).filter(
            ([, value]) =>
              typeof value === "string" || typeof value === "number" || typeof value === "boolean"
          );
          let html = output?.status
            ? "<p><strong>Response:</strong> " + escape(output.status) + "</p>"
            : "";
          html += entries
            .slice(0, 7)
            .map(
              ([key, value]) =>
                "<p><strong>" +
                escape(key.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase())) +
                ":</strong> " +
                escape(value) +
                "</p>"
            )
            .join("");
          return html || "<p>Recorded result. Expand the output details to inspect its data.</p>";
        }
        async function loadDetail() {
          const version = ++detailVersion,
            item = snapshot?.work.find((entry) => entry.id === selected);
          loadedDetail = null;
          if (!item) {
            $("detail").innerHTML = '<p class="empty">Choose a task to inspect its recorded steps.</p>';
            return;
          }
          $("detail").innerHTML = detailShell(
            item,
            '<p class="empty" style="padding:12px 0">Reading saved plan and execution…</p>',
            false
          );
          try {
            let record = detailCache.get(item.projectId + ":" + item.id);
            if (!record) {
              const digest = await read("/workspace/tools/get_work_digest", {
                id: item.id,
                projectId: item.projectId
              });
              if (item.kind === "workflow") {
                const plan = await read("/workflows/tools/get_plan", {
                  id: item.id,
                  projectId: item.projectId
                });
                const runId = plan.latestRunId || plan.attemptId;
                let run = null,
                  runError = null;
                if (runId)
                  try {
                    run = await read("/workflows/tools/get_run", {
                      id: runId,
                      projectId: item.projectId
                    });
                  } catch (error) {
                    runError = error.message;
                  }
                record = { plan, run, runError, digest };
                const changedRun =
                  !runError && (digest.run?.id !== run?.id || digest.run?.status !== run?.status);
                if (digest.revision !== plan.revision || changedRun)
                  record.digest = {
                    ...digest,
                    state: "needs_attention",
                    stateText:
                      "The work summary and saved execution changed during this read. Refresh to load a consistent view.",
                    next: null,
                    decision: null,
                    progress: null,
                    lastOutcome: null,
                    approval: null,
                    verification: null
                  };
              } else {
                const coding = await read(
                  "/development/plans/" + encodeURIComponent(item.id) + "/status"
                );
                record = { coding, digest };
              }
              detailCache.set(item.projectId + ":" + item.id, record);
            }
            if (version !== detailVersion || selected !== item.id) return;
            loadedDetail = record;
            renderDetail();
          } catch (error) {
            if (version !== detailVersion) return;
            $("detail").innerHTML = detailShell(
              item,
              '<div class="notice">' + icon("alert") + "<span>" + escape(error.message) + "</span></div>"
            );
            bindDetail(item);
          }
        }
        function renderDetail() {
          const item = snapshot?.work.find((entry) => entry.id === selected);
          if (!item || !loadedDetail) return;
          const record = loadedDetail;
          let body = "";
          if (record.coding) {
            const coding = record.coding,
              leaves = coding.leaves || [];
            body =
              '<div class="section-heading"><h3>Recorded plan</h3><small>' +
              leaves.length +
              " work items</small></div>";
            if (coding.status !== "ok")
              body +=
                '<div class="notice">' +
                icon("alert") +
                "The recorded plan state is unavailable or invalid.</div>";
            else if (detailTab === "activity")
              body +=
                '<p class="goal">This source provides a current state snapshot, not an execution event history. Open its recorded attempts for execution details.</p>';
            else
              body +=
                '<div class="step-list">' +
                leaves
                  .slice(0, 8)
                  .map(
                    (leaf, index) =>
                      '<div class="step"><span class="step-marker ' +
                      (["accepted", "cancelled"].includes(leaf.state) ? "complete" : "") +
                      '">' +
                      (index + 1) +
                      '</span><span class="step-name">' +
                      escape(leaf.name || "Untitled work item") +
                      "<small>" +
                      escape(leaf.scope || "No scope recorded") +
                      '</small></span><span class="step-right">' +
                      escape(codingStateLabel(leaf.state)) +
                      "</span></div>"
                  )
                  .join("") +
                '</div><div class="result-card"><div class="result-title">Current / next step<span>Recorded state</span></div><p>' +
                escape(item.nextStep || "No next step returned by the project service.") +
                "</p><p><strong>Execution:</strong> " +
                (item.prepared
                  ? "Prepared on the configured host."
                  : "This plan is not prepared for execution on this host.") +
                "</p></div>";
            $("detail").innerHTML = detailShell(item, body);
            bindDetail(item);
            return;
          }
          const plan = record.plan,
            run = record.run?.revision === record.plan.revision ? record.run : null,
            steps = plan.definition.steps;
          const historicalRun = record.run && !run ? record.run : null;
          let current = run?.steps.findIndex((step) => !["completed", "skipped"].includes(step.status));
          if (current === undefined || current < 0) current = steps.length - 1;
          if (!run) current = 0;
          if (chosenStep !== null) chosenStep = Math.max(0, Math.min(chosenStep, steps.length - 1));
          const index = chosenStep === null ? current : chosenStep,
            definition = steps[index],
            execution = run?.steps.find((step) => step.id === definition.id);
          if (detailTab === "activity") {
            const events = [],
              activityRun = record.run;
            if (activityRun)
              events.push({
                title:
                  (historicalRun
                    ? "Historical execution · revision " + historicalRun.revision + " · "
                    : "Execution ") + stateLabel(activityRun.status).toLowerCase(),
                text:
                  activityRun.error ||
                  (historicalRun
                    ? "This execution belongs to an older saved definition. It does not describe the current plan."
                    : "Recorded execution state."),
                at: activityRun.updatedAt || activityRun.startedAt
              });
            for (const step of activityRun?.steps || []) {
              if (step.agent)
                for (const event of step.agent.events)
                  events.push({ title: step.name, text: event.message, at: event.at });
              else if (step.status !== "pending")
                events.push({
                  title: step.name + " · " + stateLabel(step.status),
                  text:
                    step.error ||
                    (step.output === undefined ? "No output recorded." : "Output saved with this step."),
                  at: step.endedAt || step.startedAt
                });
            }
            body = events.length
              ? '<ul class="activity-list">' +
                events
                  .map(
                    (event) =>
                      '<li class="activity-item"><span class="activity-point"></span><div><strong>' +
                      escape(event.title) +
                      "</strong><p>" +
                      escape(event.text) +
                      "</p>" +
                      (event.at
                        ? '<time datetime="' +
                          escape(event.at) +
                          '">' +
                          escape(new Date(event.at).toLocaleString()) +
                          "</time>"
                        : "") +
                      "</div></li>"
                  )
                  .join("") +
                "</ul>"
              : '<p class="goal">No execution has been recorded for this saved plan.</p>';
          } else {
            const complete = (run?.steps || []).filter((step) => step.status === "completed").length;
            body =
              '<div class="section-heading"><h3>Plan</h3><small>' +
              complete +
              " of " +
              steps.length +
              ' steps complete</small></div><div class="step-list">' +
              steps
                .map((step, number) => {
                  const recorded = run?.steps.find((value) => value.id === step.id),
                    state = recorded?.status || "pending";
                  const kind = { tool: "API / tool", model: "Model", human: "Human", agent: "Agent" }[
                    step.action.type
                  ];
                  const actor =
                    step.action.tool ||
                    step.action.executor ||
                    (step.action.type === "human" ? "Human" : "Configured model");
                  return (
                    '<button class="step ' +
                    (state === "waiting_input" ? "current" : "") +
                    (chosenStep === number ? " chosen" : "") +
                    '" data-step="' +
                    number +
                    '"><span class="step-marker ' +
                    (state === "completed" ? "complete" : state === "waiting_input" ? "review" : "") +
                    '">' +
                    (state === "completed" ? icon("check") : number + 1) +
                    '</span><span class="step-name">' +
                    escape(step.name) +
                    "<small>" +
                    kind +
                    " · " +
                    escape(actor) +
                    '</small></span><span class="step-right">' +
                    escape(stateLabel(state)) +
                    "</span></button>"
                  );
                })
                .join("") +
              "</div>";
            const decisions = (run?.steps || []).filter(
              (step) =>
                step.status === "completed" &&
                steps.find((definition) => definition.id === step.id)?.action.type === "human"
            );
            if (decisions.length)
              body +=
                '<section aria-label="Recorded decisions"><div class="section-heading"><h3>Decisions</h3></div><ul class="decision-history">' +
                decisions
                  .map(
                    (step) =>
                      "<li><strong>" +
                      escape(step.name) +
                      " · " +
                      (step.output?.approved === true
                        ? "Approved"
                        : step.output?.approved === false
                          ? "Not approved"
                          : "Decision recorded") +
                      "</strong>" +
                      (typeof step.output?.note === "string"
                        ? "<p>" + escape(step.output.note) + "</p>"
                        : "") +
                      '<time datetime="' +
                      escape(step.endedAt || "") +
                      '">' +
                      escape(
                        step.endedAt ? new Date(step.endedAt).toLocaleString() : "Time not recorded"
                      ) +
                      "</time></li>"
                  )
                  .join("") +
                "</ul></section>";
            const input = execution?.inputs ?? definition.inputs;
            body +=
              '<div class="io-grid"><div class="io"><div class="eyebrow">Input</div><p>' +
              escape(compact(input)) +
              '</p></div><div class="io"><div class="eyebrow">Output</div><p>' +
              escape(
                execution?.output === undefined
                  ? stateLabel(execution?.status || "pending")
                  : compact(execution.output)
              ) +
              "</p></div></div>";
            body +=
              '<div class="result-card"><div class="result-title">' +
              (definition.action.type === "tool"
                ? "Returned data"
                : definition.action.type === "human"
                  ? "Decision"
                  : "Recorded output") +
              "<span>" +
              escape(definition.name) +
              "</span></div>";
            if (definition.action.type === "human")
              body += "<p>" + escape(definition.action.instructions) + "</p>";
            body += resultHtml(execution?.output);
            if (execution?.error)
              body += '<div class="notice">' + icon("alert") + escape(execution.error) + "</div>";
            body +=
              "<p><strong>Success:</strong> " +
              escape(
                definition.success
                  ? definition.success.path + " equals " + JSON.stringify(definition.success.equals)
                  : "No extra success rule is defined for this step."
              ) +
              "</p></div>";
            if (definition.action.type === "agent") {
              const task = definition.action.task;
              body +=
                '<div class="context-line"><span>' +
                icon("link") +
                escape(
                  task.references.map((reference) => reference.label).join(", ") ||
                    "No attached references"
                ) +
                "</span><span>" +
                icon("tools") +
                escape(task.tools.join(", ") || "No tools allowed") +
                '</span></div><div class="assignment">Executor: ' +
                escape(definition.action.executor) +
                " · " +
                task.completionCriteria.length +
                " completion criteria</div>";
              if (task.context)
                body +=
                  '<details><summary>Task context and completion criteria</summary><p class="goal">' +
                  escape(task.context) +
                  "</p><ul>" +
                  task.completionCriteria.map((value) => "<li>" + escape(value) + "</li>").join("") +
                  "</ul></details>";
              const pending = execution?.agent?.requests.find((request) => request.status === "pending");
              if (pending)
                body += '<div class="notice">' + icon("alert") + escape(pending.prompt) + "</div>";
            } else
              body +=
                '<div class="context-line"><span>' +
                icon("tools") +
                escape(
                  definition.action.type === "tool"
                    ? definition.action.tool
                    : definition.action.type === "human"
                      ? "Human review"
                      : "Configured model"
                ) +
                "</span><span>" +
                icon("link") +
                "Saved plan revision " +
                plan.revision +
                "</span></div>";
            if (execution?.output !== undefined)
              body +=
                "<details><summary>Output details</summary><pre>" +
                escape(JSON.stringify(execution.output, null, 2)) +
                "</pre></details>";
            body +=
              "<details><summary>Input details</summary><pre>" +
              escape(JSON.stringify(input, null, 2)) +
              "</pre></details><details><summary>View plan definition (JSON)</summary><pre>" +
              escape(JSON.stringify(plan.definition, null, 2)) +
              "</pre></details>";
          }
          if (historicalRun && detailTab === "plan")
            body +=
              '<div class="notice">' +
              icon("clock") +
              "<span>The saved plan is revision " +
              plan.revision +
              ". Its latest execution belongs to revision " +
              historicalRun.revision +
              " and is shown as history in Activity.</span></div>";
          if (record.runError)
            body +=
              '<div class="notice">' +
              icon("alert") +
              "<span>Execution could not be read: " +
              escape(record.runError) +
              "</span></div>";
          $("detail").innerHTML = detailShell(item, body);
          bindDetail(item);
        }
        function openConversation(item) {
          if (!item?.reopenable) return;
          window.dispatchEvent(
            new CustomEvent("workspace-open-conversation", { detail: { conversationId: item.id } })
          );
        }
        function openCurrent(item, run = false, respond = false) {
          if (!item) return;
          return action(async () => {
            if (item.kind === "workflow") {
              const linkedConversation = snapshot?.conversations.find(
                (row) => row.id === item.conversationId
              );
              if (linkedConversation?.reopenable && $("conversationId")?.value !== item.conversationId) {
                if ($("prompt")?.value.trim() || $("composer")?.dataset.submitting === "true")
                  throw new Error(
                    "Finish or clear the current message before opening this plan's conversation."
                  );
                await waitFor(
                  () => $("workspaceNewConversation") && !$("workspaceNewConversation").disabled
                );
                await outcome(
                  "workspace-conversation-selected",
                  (event) => event.detail?.conversationId === item.conversationId,
                  () =>
                    window.dispatchEvent(
                      new CustomEvent("workspace-open-conversation", {
                        detail: { conversationId: item.conversationId }
                      })
                    )
                );
              }
              if (respond) {
                const opened = await outcome(
                  "workspace-plan-opened",
                  (event) =>
                    event.detail?.id === item.id &&
                    (event.detail.projectId || null) === (item.projectId || null),
                  () =>
                    window.dispatchEvent(
                      new CustomEvent("workspace-open-plan", {
                        detail: { id: item.id, projectId: item.projectId, respond: true }
                      })
                    )
                );
                if (!opened.opened) throw new Error(opened.error || "This plan could not be opened.");
                const section = $("workflowRespond");
                if (
                  section.hidden ||
                  section.dataset.planId !== item.id ||
                  section.dataset.projectId !== (item.projectId || "")
                )
                  throw new Error(
                    "This execution is no longer waiting for a response. Open its controls to inspect the saved state."
                  );
                showAction("Respond · " + section.dataset.stepName, [section]);
              } else {
                showAction(item.name, [$("workflowPanel")]);
                window.dispatchEvent(
                  new CustomEvent("workspace-open-plan", {
                    detail: { id: item.id, projectId: item.projectId, run: run === true }
                  })
                );
              }
              if (item.conversationId && !linkedConversation?.reopenable)
                feedback(
                  linkedConversation
                    ? "The originating conversation cannot be continued. This plan's controls remain available independently."
                    : "The originating conversation is not available in this view. This plan's controls remain available independently."
                );
            } else {
              const root = $("planRoot");
              if (!root) {
                feedback("Coding plan controls are not configured on this host.");
                return;
              }
              showAction(item.name, [$("planStatusPanel"), $("planRunControls"), $("attemptProgress")]);
              root.value = item.id;
              root.dispatchEvent(new Event("change"));
              $("planStatusPanel").open = true;
              $("planRefresh").click();
              if (!$("planRunControls"))
                feedback("Coding plan inspection is available. Execution is unavailable on this host.");
            }
          });
        }
        function renderConversations() {
          const items = visibleConversations();
          if (
            !items.some((item) => item.id === selectedConversation) &&
            !(chatVisible && selectedConversation === activeConversationId)
          )
            selectedConversation = items[0]?.id || null;
          $("conversationList").innerHTML = items.length
            ? items
                .map(
                  (item) =>
                    '<button class="conversation-row ' +
                    (item.id === selectedConversation ? "selected" : "") +
                    '" data-conversation="' +
                    escape(item.id) +
                    '"><strong>' +
                    escape(item.title) +
                    "</strong><p>" +
                    escape(item.preview || "No saved messages yet.") +
                    "</p><span>" +
                    escape(projectName(item.projectId)) +
                    " · " +
                    escape(conversationState(item)) +
                    "</span></button>"
                )
                .join("")
            : '<p class="empty">No saved conversations match this selection.</p>';
          $("conversationList")
            .querySelectorAll("[data-conversation]")
            .forEach((button) =>
              button.addEventListener("click", () => {
                selectedConversation = button.dataset.conversation;
                renderConversations();
                loadConversation();
              })
            );
        }
        function historyMessages(events) {
          const messages = [];
          const attempts = new Map();
          for (const event of events) {
            if (event.type === "user") messages.push({ role: "You", text: event.text, user: true });
            else if (["provisional", "refined", "delta"].includes(event.type)) {
              const key = event.messageId + ":" + (event.attemptId || event.phase || event.type);
              let record = attempts.get(key);
              if (!record) {
                record = {
                  role: event.model ? event.model.provider + " / " + event.model.model : "Assistant",
                  text: "",
                  user: false
                };
                attempts.set(key, record);
                messages.push(record);
              }
              record.text = event.type === "delta" ? record.text + event.text : event.text;
              if (event.model) record.role = event.model.provider + " / " + event.model.model;
            }
          }
          return messages.filter((item) => item.text).slice(-4);
        }
        async function loadConversation() {
          const version = ++conversationVersion;
          if (activeConversationId && selectedConversation === activeConversationId && chatVisible) {
            mountChat();
            return;
          }
          stashChat();
          const item = snapshot?.conversations.find((row) => row.id === selectedConversation);
          if (!item) {
            $("conversationDetail").innerHTML = '<p class="empty">Choose a saved conversation.</p>';
            return;
          }
          $("conversationDetail").innerHTML = '<p class="empty">Reading saved conversation…</p>';
          try {
            let data = historyCache.get(item.id);
            if (!data) {
              data = await read("/workspace/conversations/" + encodeURIComponent(item.id) + "/events");
              historyCache.set(item.id, data);
            }
            if (
              version !== conversationVersion ||
              selectedConversation !== item.id ||
              view !== "conversations"
            )
              return;
            const messages = historyMessages(data.events || []),
              linked = snapshot.work.filter((row) => row.conversationId === item.id);
            const chips = linked
              .map(
                (row) =>
                  '<div class="plan-chip">' +
                  icon("work") +
                  '<span class="chip-text"><strong>' +
                  escape(row.name) +
                  "</strong><small>" +
                  escape(stateLabel(row.status)) +
                  '</small></span><button class="button" data-linked-plan="' +
                  escape(row.id) +
                  '">Open plan</button></div>'
              )
              .join("");
            $("conversationDetail").innerHTML =
              '<header class="chat-head"><div class="detail-meta"><span class="detail-project">' +
              icon("folder") +
              escape(projectName(item.projectId)) +
              "</span>" +
              '<span class="badge">' +
              escape(conversationState(item)) +
              "</span>" +
              "</div><h2>" +
              escape(item.title) +
              "</h2><p>Actual saved history · " +
              (data.events || []).length +
              ' recorded events</p></header><div class="chat-messages">' +
              (messages.length
                ? messages
                    .map(
                      (message) =>
                        '<div class="message ' +
                        (message.user ? "user" : "") +
                        '"><strong>' +
                        escape(message.role) +
                        '</strong><div style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto">' +
                        escape(message.text) +
                        "</div></div>"
                    )
                    .join("")
                : '<p class="goal">No messages saved yet. Open this conversation to begin.</p>') +
              chips +
              '</div><div class="chat-composer"><footer><small>Scoped to ' +
              escape(projectName(item.projectId)) +
              '</small><button class="button primary" id="continueConversation" ' +
              (!item.reopenable ? "disabled" : "") +
              ">" +
              icon("chat") +
              'Continue conversation</button></footer><p class="demo-note">Open this conversation to continue with the model and manage its work here.</p></div>';
            $("continueConversation").addEventListener("click", () => openConversation(item));
            $("conversationDetail")
              .querySelectorAll("[data-linked-plan]")
              .forEach((button) =>
                button.addEventListener("click", () =>
                  action(async () => {
                    const linkedWork = snapshot.work.find((row) => row.id === button.dataset.linkedPlan);
                    if (!linkedWork) return;
                    const scope = linkedWork.projectId || "all";
                    if (project !== scope) {
                      await waitFor(
                        () => $("workspaceNewConversation") && !$("workspaceNewConversation").disabled
                      );
                      await outcome(
                        "workspace-project-selected",
                        (event) => (event.detail?.projectId || "all") === scope,
                        () => requestProject(scope)
                      );
                    }
                    status = "all";
                    query = "";
                    $("search").value = "";
                    selected = linkedWork.id;
                    chosenStep = null;
                    setView("work");
                  })
                )
              );
          } catch (error) {
            if (version !== conversationVersion) return;
            $("conversationDetail").innerHTML =
              '<header class="chat-head"><h2>' +
              escape(item.title) +
              '</h2></header><p class="empty">' +
              escape(error.message) +
              "</p>";
          }
        }
        function render() {
          if (!snapshot) return;
          renderNavigation();
          renderCounts();
          const items = visibleWork();
          if (!items.some((item) => item.id === selected)) {
            selected = items.find((item) => item.status === "waiting_input")?.id || items[0]?.id || null;
            chosenStep = null;
            loadedDetail = null;
          }
          renderList();
          renderConversations();
          if (view === "work") loadDetail();
          else loadConversation();
        }
        function setView(value) {
          view = value;
          $("workView").hidden = value !== "work";
          $("conversationsView").hidden = value !== "conversations";
          ["work", "conversations"].forEach((name) => {
            $(name + "Tab").classList.toggle("active", value === name);
            $(name + "Tab").setAttribute("aria-selected", String(value === name));
          });
          $("pageTitle").textContent =
            value === "work" ? "Your work, at a glance." : "A place to think together.";
          $("pageDescription").textContent =
            value === "work"
              ? "See what needs you, what’s moving, and what comes next."
              : "Keep the discussion connected to the project and its work.";
          render();
        }
        async function loadWorkspace() {
          if (loadingWorkspace) {
            pendingWorkspaceReload = true;
            return;
          }
          loadingWorkspace = true;
          $("refresh").disabled = true;
          $("loadStatus").textContent = "Reading actual projects, conversations and work…";
          try {
            const session = await read("/auth/session");
            if (session.authenticated !== true)
              throw new Error("Pair this browser to view your workspace.");
            const scope = project;
            const result = await read(
              "/workspace/tools/get_workspace",
              scope === "all" ? {} : { projectId: scope }
            );
            if (scope !== project) {
              pendingWorkspaceReload = true;
              return;
            }
            snapshot = result;
            if (pendingCreatedPlanId && snapshot.work.some((item) => item.id === pendingCreatedPlanId)) {
              selected = pendingCreatedPlanId;
              pendingCreatedPlanId = null;
              chosenStep = null;
              detailTab = "plan";
              status = "outstanding";
            }
            loadedScope = scope;
            detailCache.clear();
            historyCache.clear();
            $("loadStatus").textContent =
              "Updated " +
              new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) +
              (snapshot.truncated ? " · More work exists. Choose a project to narrow the view." : "");
            $("workspacePersistence").textContent = snapshot.persistenceEnabled
              ? "Workspace saved on this host."
              : "Workspace storage is temporary on this host.";
            const errors = (snapshot.errors || []).map(
              (item) => projectName(item.projectId) + ": " + item.message
            );
            $("loadErrors").hidden = !errors.length;
            $("loadErrors").textContent = errors.join(" ");
            render();
          } catch (error) {
            $("loadErrors").hidden = false;
            $("loadErrors").textContent = error.message;
            $("loadStatus").textContent = snapshot
              ? "Refresh failed. The last loaded records are still shown."
              : "Workspace has not loaded. Try refreshing or check your connection.";
            if (!snapshot) {
              $("projects").innerHTML = '<a class="button" href="/pair">Pair this browser</a>';
              $("workList").innerHTML = '<p class="empty">Live data is unavailable.</p>';
            }
          } finally {
            loadingWorkspace = false;
            $("refresh").disabled = false;
            if (pendingWorkspaceReload) {
              pendingWorkspaceReload = false;
              setTimeout(loadWorkspace, 0);
            }
          }
        }
        document.querySelectorAll("[data-status]").forEach((button) =>
          button.addEventListener("click", () => {
            status = button.dataset.status;
            chosenStep = null;
            render();
          })
        );
        $("search").addEventListener("input", (event) => {
          query = event.target.value.trim().toLowerCase();
          render();
        });
        $("workTab").addEventListener("click", () => setView("work"));
        $("conversationsTab").addEventListener("click", () => setView("conversations"));
        $("refresh").addEventListener("click", loadWorkspace);
        document.addEventListener("keydown", (event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
            event.preventDefault();
            $("search").focus();
          }
        });
        window.addEventListener("pagehide", () => requests.forEach((controller) => controller.abort()));

        const legacyHolder = $("workspaceLegacyControls"),
          dialog = $("workspaceActionDialog"),
          actionBody = $("workspaceActionBody"),
          chat = document.querySelector("#workspaceLegacyControls .chat-shell");
        let activeConversationId = null,
          activeConversationTitle = "Conversation",
          activeConversationProject = null,
          chatVisible = false,
          actionBusy = false,
          hasOpenControls = false;
        const movableIds = [
          "workflowPanel",
          "workspacePanel",
          "planStatusPanel",
          "planRunControls",
          "attemptProgress",
          "executiveOverview"
        ];
        movableIds.forEach((id) => {
          const element = $(id);
          if (element) legacyHolder.append(element);
        });
        if (chat) {
          const composer = $("composer"),
            thread = $("thread"),
            notice = $("conversationNotice");
          if (thread && composer) chat.insertBefore(thread, composer);
          if (notice && thread) chat.insertBefore(notice, thread);
        }
        function feedback(message) {
          $("workspaceActionStatus").hidden = !message;
          $("workspaceActionStatus").textContent = message || "";
          $("workspaceActionDialogStatus").hidden = !message;
          $("workspaceActionDialogStatus").textContent = message || "";
        }
        function stashChat() {
          if (chat && chat.parentElement !== legacyHolder) legacyHolder.append(chat);
          $("conversationDetail").classList.remove("legacy-controls-scope");
        }
        function linkedWorkHtml(conversationId) {
          return (snapshot?.work || [])
            .filter((row) => row.conversationId === conversationId)
            .map(
              (row) =>
                '<div class="plan-chip">' +
                icon("work") +
                '<span class="chip-text"><strong>' +
                escape(row.name) +
                "</strong><small>" +
                escape(stateLabel(digestOf(row).state)) +
                '</small></span><button class="button" data-live-plan="' +
                escape(row.id) +
                '">Open plan</button></div>'
            )
            .join("");
        }
        function mountChat() {
          if (!chat || !activeConversationId) return;
          ++conversationVersion;
          const heading = chat.querySelector(".panel-header h1"),
            sub = chat.querySelector(".panel-header .sub");
          if (heading) heading.textContent = activeConversationTitle;
          if (sub) sub.textContent = projectName(activeConversationProject) + " · Active conversation";
          const target = $("conversationDetail");
          if (chat.parentElement !== target) {
            target.replaceChildren(chat);
            target.classList.add("legacy-controls-scope");
          }
          let links = $("conversationLinkedWork");
          if (!links) {
            links = document.createElement("div");
            links.id = "conversationLinkedWork";
            chat.insertBefore(links, $("thread"));
          }
          links.innerHTML = linkedWorkHtml(activeConversationId);
          links
            .querySelectorAll("[data-live-plan]")
            .forEach((button) =>
              button.addEventListener("click", () =>
                openCurrent(snapshot?.work.find((row) => row.id === button.dataset.livePlan))
              )
            );
          chat.hidden = false;
        }
        let pendingCreatedPlanId = null;
        const actionHomes = new Map();
        let actionElements = [],
          actionTitle = "";
        function restoreAction() {
          for (const child of actionElements.slice().reverse()) {
            if (child.tagName === "DETAILS") child.open = false;
            const home = actionHomes.get(child);
            if (home)
              home.parent.insertBefore(child, home.next?.parentNode === home.parent ? home.next : null);
          }
          if ($("workflowPanel")) $("workflowPanel").open = false;
        }
        function showAction(title, elements) {
          restoreAction();
          actionElements = elements.filter(Boolean);
          actionTitle = title;
          $("workspaceActionTitle").textContent = title;
          dialog.classList.toggle("response-dialog", actionElements.includes($("workflowRespond")));
          actionElements.forEach((element) => {
            if (!actionHomes.has(element))
              actionHomes.set(element, { parent: element.parentNode, next: element.nextSibling });
            actionBody.append(element);
            element.hidden = false;
            if (element.tagName === "DETAILS") element.open = true;
          });
          if (actionElements.includes($("workflowRespond"))) $("workflowPanel").open = true;
          hasOpenControls = actionElements.length > 0;
          $("workspaceActionReopen").hidden = true;
          if (!dialog.open) dialog.showModal();
        }
        $("workspaceActionClose").addEventListener("click", () => dialog.close());
        dialog.addEventListener("close", () => {
          restoreAction();
          $("workspaceActionReopen").hidden = !hasOpenControls;
          loadWorkspace();
        });
        $("workspaceActionReopen").addEventListener("click", () => {
          if (hasOpenControls) showAction(actionTitle, actionElements);
        });
        $("workflowRespondAdvanced")?.addEventListener("click", () => {
          showAction($("workflowTitle").textContent || "Workflow controls", [$("workflowPanel")]);
        });
        function requestProject(id) {
          window.dispatchEvent(
            new CustomEvent("workspace-select-project", {
              detail: { projectId: id === "all" ? null : id }
            })
          );
        }
        function outcome(type, matches, request) {
          return new Promise((resolve, reject) => {
            const listener = (event) => {
              if (!matches(event)) return;
              clearTimeout(timer);
              window.removeEventListener(type, listener);
              resolve(event.detail);
            };
            const timer = setTimeout(() => {
              window.removeEventListener(type, listener);
              reject(
                new Error(
                  $("workspaceNote")?.textContent ||
                    "The selection could not be opened. Finish the current request and try again."
                )
              );
            }, 12000);
            window.addEventListener(type, listener);
            request();
          });
        }
        async function waitFor(enabled, ms = 12000) {
          const until = Date.now() + ms;
          while (Date.now() < until) {
            if (enabled()) return;
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
          throw new Error(
            "The controls are busy or unavailable. Try again after their current request finishes."
          );
        }
        async function action(operation) {
          if (actionBusy) return;
          actionBusy = true;
          setActionButtons();
          try {
            await operation();
          } catch (error) {
            feedback(error.message);
          } finally {
            const panel = $("workflowPanel");
            if (
              panel &&
              (!dialog.open ||
                (!actionBody.contains(panel) && !actionBody.contains($("workflowRespond"))))
            )
              panel.open = false;
            actionBusy = false;
            setActionButtons();
          }
        }
        function setActionButtons() {
          [
            "shellNewConversation",
            "shellNewWorkflow",
            "shellNewAgentTask",
            "shellNewProject",
            "shellEditProject",
            "shellManageWorkspace",
            "shellToolsActivity",
            "openCurrent",
            "runCurrent",
            "continueConversation",
            "respondCurrent",
            "respondDecision"
          ].forEach((id) => {
            if ($(id)) $(id).disabled = actionBusy;
          });
          $("shellEditProject").disabled = actionBusy || project === "all";
        }
        function manage(mode) {
          return action(async () => {
            const panel = $("workspacePanel");
            if (!panel) {
              feedback("Workspace management is not configured.");
              return;
            }
            showAction("Manage workspace", [panel]);
            if (mode) {
              const button = $(mode === "new" ? "workspaceNewProject" : "workspaceEditProject");
              await waitFor(() => button && !button.disabled);
              button.click();
            }
          });
        }
        $("shellToolsActivity").addEventListener("click", () => {
          const panels = [
            $("executiveOverview"),
            document.querySelector("aside.side"),
            $("gamesPanel"),
            $("teamDirectoryPanel")
          ].filter((element) => element && !element.hidden);
          showAction("Tools & activity", panels);
        });
        $("shellManageWorkspace").addEventListener("click", () => manage());
        $("shellNewProject").addEventListener("click", () => manage("new"));
        $("shellEditProject").addEventListener("click", () => manage("edit"));
        $("shellNewWorkflow").addEventListener("click", () => createWork(false));
        $("shellNewAgentTask").addEventListener("click", () => createWork(true));
        function createWork(agent) {
          return action(async () => {
            const panel = $("workflowPanel"),
              button = $(agent ? "workflowNewAgent" : "workflowNew");
            if (!panel || !button) {
              feedback("Workflow controls are not configured.");
              return;
            }
            await waitFor(() => !button.disabled);
            if (agent) showAction("New agent task", [panel]);
            button.click();
          });
        }
        $("shellNewConversation").addEventListener("click", () =>
          action(async () => {
            const button = $("workspaceNewConversation");
            await waitFor(() => button && !button.disabled);
            $("workspaceConversationTitle").value = "";
            window.dispatchEvent(new CustomEvent("workspace-new-conversation"));
          })
        );
        window.addEventListener("workspace-project-selected", (event) => {
          project = event.detail?.projectId || "all";
          chosenStep = null;
          setActionButtons();
          render();
          if (snapshot?.truncated || loadedScope !== "all") loadWorkspace();
        });
        window.addEventListener("workspace-conversation-selected", (event) => {
          if (!event.detail?.conversationId) return;
          activeConversationId = event.detail.conversationId;
          activeConversationTitle =
            event.detail.title ||
            snapshot?.conversations.find((row) => row.id === activeConversationId)?.title ||
            "Conversation";
          activeConversationProject = event.detail.projectId || null;
          selectedConversation = activeConversationId;
          project = event.detail.projectId || "all";
          chatVisible = true;
          if (dialog.open) dialog.close();
          setView("conversations");
          mountChat();
          loadWorkspace();
        });
        window.addEventListener("workspace-new-workflow-form", (event) => {
          showAction("New workflow" + (event.detail?.projectId ? " · " + projectName(event.detail.projectId) : ""), [$("workflowBuilder")]);
        });
        window.addEventListener("workspace-workflow-advanced", () => {
          showAction("Advanced plan JSON", [$("workflowPanel")]);
        });
        window.addEventListener("workspace-open-plan", (event) => {
          if (!event.detail?.id || event.detail.respond) return;
          const item = snapshot?.work.find((entry) => entry.id === event.detail.id);
          showAction(item?.name || "Workflow controls", [$("workflowPanel")]);
        });
        window.addEventListener("workspace-work-changed", (event) => {
          if (event.detail?.createdPlanId) {
            pendingCreatedPlanId = event.detail.createdPlanId;
            query = "";
            $("search").value = "";
            hasOpenControls = false;
            if (dialog.open) dialog.close();
            setView("work");
            feedback("Plan saved. Review it and click Run when ready.");
          }
          const response = $("workflowRespond");
          if (
            event.detail?.responseSaved &&
            dialog.open &&
            actionBody.contains(response) &&
            response.dataset.runId === event.detail.runId
          ) {
            hasOpenControls = false;
            dialog.close();
            feedback("Answer saved.");
          }
          loadWorkspace();
        });
        const workspaceNote = $("workspaceNote");
        if (workspaceNote)
          new MutationObserver(() => {
            const note = workspaceNote.textContent || "";
            const storage = [
              "Workspace saved on this host.",
              "Workspace storage is temporary on this host."
            ].find((prefix) => note.startsWith(prefix));
            if (storage) {
              $("workspacePersistence").textContent = storage;
              feedback(note.slice(storage.length).trim());
              return;
            }
            feedback(workspaceNote.textContent);
          }).observe(workspaceNote, {
            childList: true,
            subtree: true,
            characterData: true
          });
        let selectionFrame = 0,
          scrollSelectedPage = false;
        function scheduleSelectionPin(scrollPage) {
          scrollSelectedPage ||= scrollPage;
          if (selectionFrame) return;
          selectionFrame = requestAnimationFrame(() => {
            selectionFrame = 0;
            pinSelectedWork(scrollSelectedPage);
            scrollSelectedPage = false;
          });
        }
        window.addEventListener("resize", () => scheduleSelectionPin(true));
        const selectionResizeObserver = new ResizeObserver(() => scheduleSelectionPin(false));
        selectionResizeObserver.observe($("workList"));
        window.addEventListener("pagehide", () => {
          selectionResizeObserver.disconnect();
          cancelAnimationFrame(selectionFrame);
          selectionFrame = 0;
          scrollSelectedPage = false;
        });
        setActionButtons();
        loadWorkspace();
      })();
    </script>
  </body>
</html>
`;
