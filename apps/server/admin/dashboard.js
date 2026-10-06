import { chart } from "./charts.js";
const $ = (id) => document.getElementById(id);
const count = (n) =>
  n === null || n === undefined
    ? "—"
    : new Intl.NumberFormat("en-IN").format(n);
let snapshot;
let requestVersion = 0;
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
function empty(target, text = "No recorded activity in this window.") {
  target.replaceChildren(element("p", text, "empty"));
}
function bars(target, rows) {
  chart(
    target,
    target.id === "dish-list" ? "bar" : "doughnut",
    rows.map((r) => r.name),
    [{ label: "Count", data: rows.map((r) => r.count) }],
    { horizontal: target.id === "dish-list" },
  );
}
function render(data) {
  const calls = data.langfuse.available
    ? data.modes.reduce((n, r) => n + r.count, 0)
    : null;
  const failed = data.failures
    .filter((r) => r._id.kind === "model")
    .reduce((n, r) => n + r.count, 0);
  const metrics = [
    [
      "Registered devices",
      data.users,
      `${count(data.activeUsers)} active in this window · not unique people`,
    ],
    [
      "Confirmed orders",
      data.orders,
      `${count(data.allOrders)} since coverage began`,
    ],
    ["Planning model calls", calls, `${count(failed)} LLM failed attempts`],
    [
      "Hybrid calls",
      data.hybridCalls,
      `${count(data.hybrid)} traces with local + hosted attempts`,
    ],
  ];
  $("overview").replaceChildren(
    ...metrics.map(([name, value, note]) => {
      const card = element("div", undefined, "metric");
      card.append(
        element("p", name),
        element("strong", count(value)),
        element("small", note),
      );
      return card;
    }),
  );
  bars(
    $("modes"),
    data.modes.map((r) => ({
      name:
        r._id === "unknown"
          ? "Origin not reported"
          : `${r._id === "hosted" ? "Hosted" : "Local"} LLM`,
      count: r.count,
    })),
  );
  bars(
    $("carts"),
    data.cartOutcomes.map((r) => ({
      name: r._id === "success" ? "Prepared for review" : "Preparation failed",
      count: r.count,
    })),
  );
  $("model-rows").replaceChildren();
  if (!data.models.length) {
    const tr = element("tr");
    const td = element(
      "td",
      data.langfuse.available
        ? "No model attempts recorded yet."
        : data.langfuse.reason,
    );
    td.colSpan = 5;
    tr.append(td);
    $("model-rows").append(tr);
  }
  for (const row of data.models) {
    const tr = element("tr");
    const name = element("td", row._id.model);
    name.append(element("small", row._id.provider));
    tr.append(
      name,
      element("td", row._id.kind === "vision" ? "Vision" : "Planning"),
      element("td", count(row.count)),
      element("td", count(row.failed)),
      element("td", `${count(Math.round(row.averageMs || 0))} ms`),
    );
    $("model-rows").append(tr);
  }
  chart(
    $("model-chart"),
    "bar",
    data.models.slice(0, 10).map((r) => r._id.model),
    [
      {
        label: "Successful attempts",
        data: data.models.slice(0, 10).map((r) => r.count - r.failed),
      },
      {
        label: "Failed attempts",
        backgroundColor: "#bf776b",
        data: data.models.slice(0, 10).map((r) => r.failed),
      },
    ],
    { horizontal: true },
  );
  renderDishes();
  if (data.preview) {
    empty(
      $("carts"),
      "Database counters unavailable in this read-only preview.",
    );
    empty(
      $("dish-list"),
      "Database counters unavailable in this read-only preview.",
    );
  }
  $("failures").replaceChildren();
  if (!data.failures.length)
    empty($("failures"), "No failures recorded in this window.");
  for (const row of data.failures) {
    const line = element("div", undefined, "failure");
    line.append(
      element(
        "span",
        `${row._id.kind === "server_failure" ? "HTTP 5xx" : row._id.kind === "workflow_failure" ? "Workflow" : "LLM"} · ${row._id.code}`,
      ),
      element("strong", count(row.count)),
    );
    $("failures").append(line);
  }
  const daily = new Map(data.daily.map((r) => [r._id, r.count]));
  const dates = [];
  for (let i = data.days - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000);
    const key = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
    dates.push({ key, count: daily.get(key) || 0 });
  }
  chart(
    $("timeline"),
    "line",
    data.daily.length ? dates.map((r) => r.key) : [],
    [{ label: "Observations", data: dates.map((r) => r.count) }],
    { timeline: true },
  );
  $("definitions").replaceChildren(
    ...Object.values(data.definitions).map((text) => element("p", text)),
  );
  $("coverage").textContent = data.preview
    ? "Read-only preview: live Langfuse graphs; database counters are unavailable."
    : `Coverage began ${data.coverageStartedAt ? new Date(data.coverageStartedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "not recorded yet (API instrumentation has not initialized this database)"}. Application events retained ${data.retentionDays} days; Langfuse retention follows its project; registration and confirmed-order ledgers persist. ${count(data.registrations)} new registrations and ₹${count(data.orderValue)} confirmed order payable value in this window. Analytics writes missed since this server restarted: ${count(data.droppedWritesSinceRestart)}.`;
}
function renderDishes() {
  if (!snapshot) return;
  const query = $("dish-filter").value.toLocaleLowerCase();
  bars(
    $("dish-list"),
    snapshot.dishes
      .filter((r) => r._id.toLocaleLowerCase().includes(query))
      .map((r) => ({ name: r._id, count: r.count })),
  );
}
async function load() {
  const version = ++requestVersion;
  $("refresh").disabled = true;
  $("export").disabled = true;
  $("status").textContent = "Loading live analytics…";
  try {
    const response = await fetch(`/api/admin/summary?days=${$("days").value}`, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!response.ok)
      throw Error(
        response.status === 403
          ? "Access session expired or denied. Reload to sign in."
          : response.status === 503
            ? "Analytics unavailable. Check MongoDB and Admin Access configuration."
            : `Unable to load analytics (HTTP ${response.status}).`,
      );
    const data = await response.json();
    if (version !== requestVersion) return;
    snapshot = data;
    render(data);
    $("export").disabled = false;
    $("status").textContent =
      `${data.preview ? "Read-only preview · live Langfuse" : "Live data"} · updated ${new Date(data.generatedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} IST · ${data.days}-day window${!data.langfuse.available ? " · " + data.langfuse.reason : data.langfuse.partial ? " · PARTIAL Langfuse sample (lower bounds)" : " · Langfuse: " + data.langfuse.environment}`;
  } catch (error) {
    if (version !== requestVersion) return;
    $("status").textContent =
      `${error.message} ${snapshot ? "The last successful snapshot remains displayed." : ""}`;
  } finally {
    if (version === requestVersion) $("refresh").disabled = false;
  }
}
$("refresh").addEventListener("click", load);
$("days").addEventListener("change", load);
$("dish-filter").addEventListener("input", renderDishes);
$("export").addEventListener("click", () => {
  if (!snapshot) return;
  const rows = [
    ["section", "label", "count"],
    ["summary", "registered_devices", snapshot.users],
    ["summary", "orders", snapshot.orders],
    ["summary", "hybrid_traces", snapshot.hybrid],
    ["summary", "hybrid_calls", snapshot.hybridCalls],
    ...snapshot.models.map((r) => [
      "model",
      `${r._id.kind}: ${r._id.provider}/${r._id.model}`,
      r.count,
    ]),
    ...snapshot.dishes.map((r) => ["dish", r._id, r.count]),
    ...snapshot.failures.map((r) => [
      "failure",
      `${r._id.kind}: ${r._id.code}`,
      r.count,
    ]),
  ];
  const quote = (value) =>
    `"${String(value)
      .replace(/^[=+@-]/, "'$&")
      .replaceAll('"', '""')}"`;
  const url = URL.createObjectURL(
    new Blob([rows.map((r) => r.map(quote).join(",")).join("\r\n")], {
      type: "text/csv",
    }),
  );
  const a = element("a");
  a.href = url;
  a.download = `cravelens-analytics-${snapshot.days}d.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
if (!snapshot)
  $("overview").replaceChildren(
    ...[
      "Registered devices",
      "Confirmed orders",
      "Planning model calls",
      "Hybrid calls",
    ].map((name) => {
      const card = element("div", undefined, "metric");
      card.append(
        element("p", name),
        element("strong", "—"),
        element("small", "Awaiting live data"),
      );
      return card;
    }),
  );
load();
